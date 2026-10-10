package main

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-lambda-go/events"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

const (
	actionDisposition    = "ReportDisposition"
	actionResolveDispute = "ResolveDispute"
)

var (
	stagesDisposition    = []string{"RECEIVED", "DISTRIBUTING"}
	stagesResolveDispute = []string{"RECEIVED", "DISTRIBUTING"}
)

// guard is the outcome of the shared mutating-route prefix. Exactly one of replay,
// or the lot fields, is meaningful.
type guard struct {
	lot     item
	stage   string
	version int64
	idemKey string
	replay  *string // stored response body when the idem key was already committed
}

// guarded mirrors api.py guarded(): load lot -> VP -> idem key -> idem replay ->
// stage -> expected_version. A non-nil early response ends the request.
func (a *app) guarded(ctx context.Context, lotID, sub, role, action string, body map[string]any,
	expected []string, requestID string) (*guard, *events.APIGatewayV2HTTPResponse, error) {

	lot, err := a.getLot(ctx, lotID)
	if err != nil {
		return nil, nil, err
	}
	if lot == nil {
		r := jsonResp(404, map[string]any{"error": "lot not found", "lot_id": lotID})
		return nil, &r, nil
	}
	ok, err := a.vpAuthorize(ctx, sub, role, action, lotID, lot)
	if err != nil {
		return nil, nil, err
	}
	if !ok {
		a.rejectEvent(ctx, lotID, sub, action, requestID)
		logEvent(map[string]any{"msg": "request", "request_id": requestID, "actor": sub, "action": action,
			"lot_id": lotID, "version": nAttrOr(lot, "version", 0), "exec_arn": sAttr(lot, "exec_arn"),
			"decision": "DENY", "source": "VerifiedPermissions", "status": 403})
		r := jsonResp(403, map[string]any{"error": "VP_DENY", "action": action, "actor": sub,
			"lot_id": lotID, "decision": "DENY", "request_id": requestID})
		return nil, &r, nil
	}
	idemKey, _ := body["idem_key"].(string)
	if idemKey == "" {
		r := jsonResp(400, map[string]any{"error": "idem_key is required"})
		return nil, &r, nil
	}
	ex, err := a.idemGet(ctx, lotID, idemKey)
	if err != nil {
		return nil, nil, err
	}
	if ex != nil {
		if sAttr(ex, "action") != action {
			r := jsonResp(409, map[string]any{"error": "idem_key already used for a different action",
				"action": action, "lot_id": lotID})
			return nil, &r, nil
		}
		stored := sAttr(ex, "result")
		return &guard{replay: &stored}, nil, nil
	}
	stage := sAttr(lot, "stage")
	version := nAttrOr(lot, "version", 0)
	if !contains(expected, stage) {
		r := jsonResp(409, map[string]any{"error": "invalid stage", "stage": stage, "expected": expected})
		return nil, &r, nil
	}
	ev, ok := jsonInt(body["expected_version"])
	if !ok || ev != version {
		r := jsonResp(409, map[string]any{"error": "stale or missing expected_version", "version": version})
		return nil, &r, nil
	}
	return &guard{lot: lot, stage: stage, version: version, idemKey: idemKey}, nil, nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- GET /lots

func (a *app) handleGetLots(ctx context.Context, sub, role, requestID string) (events.APIGatewayV2HTTPResponse, error) {
	all, err := a.scanLots(ctx)
	if err != nil {
		return events.APIGatewayV2HTTPResponse{}, err
	}
	lots := visibleLots(all, role, sub)
	out := make([]map[string]any, 0, len(lots))
	for _, lot := range lots {
		out = append(out, public(lot))
	}
	logEvent(map[string]any{"msg": "request", "request_id": requestID, "actor": sub, "action": "ListLots",
		"decision": "ALLOW", "status": 200, "count": len(out)})
	return jsonResp(200, map[string]any{"lots": out}), nil
}

// ---------------------------------------------------------------- disposition

// checkDisposition validates returned/disposed against the remaining stock. A status of 0
// means valid; otherwise msg is the error text for the response body.
func checkDisposition(returned, disposed, remaining int64) (int, string) {
	if returned < 0 || disposed < 0 {
		return 400, "returned and disposed must be >= 0"
	}
	if returned == 0 && disposed == 0 {
		return 400, "at least one of returned or disposed must be > 0"
	}
	if returned+disposed > remaining {
		return 409, "exceeds remaining"
	}
	return 0, ""
}

// checkResolve validates a reconciled received count against the accounted stock.
func checkResolve(reconciled, distributed, returned, disposed int64) (int, string) {
	if accounted := distributed + returned + disposed; reconciled < accounted {
		return 409, fmt.Sprintf("reconciled_received must be >= distributed+returned+disposed (%d)", accounted)
	}
	return 0, ""
}

func (a *app) handleDisposition(ctx context.Context, lotID, sub, role string, body map[string]any, requestID string) (events.APIGatewayV2HTTPResponse, error) {
	g, early, err := a.guarded(ctx, lotID, sub, role, actionDisposition, body, stagesDisposition, requestID)
	if err != nil {
		return events.APIGatewayV2HTTPResponse{}, err
	}
	if early != nil {
		return *early, nil
	}
	if g.replay != nil {
		return rawResp(200, *g.replay), nil
	}

	returned, okR := optionalInt(body, "returned")
	disposed, okD := optionalInt(body, "disposed")
	if !okR || !okD {
		return jsonResp(400, map[string]any{"error": "returned and disposed must be integers"}), nil
	}
	lot := g.lot
	received := nAttrOr(lot, "received", 0)
	distributed := nAttrOr(lot, "distributed", 0)
	prevReturned := nAttrOr(lot, "returned", 0)
	prevDisposed := nAttrOr(lot, "disposed", 0)
	remaining := nAttrOr(lot, "remaining", 0)

	if status, msg := checkDisposition(returned, disposed, remaining); status != 0 {
		return jsonResp(status, map[string]any{"error": msg}), nil
	}
	newReturned := prevReturned + returned
	newDisposed := prevDisposed + disposed
	newRemaining := remaining - returned - disposed
	if received != distributed+newReturned+newDisposed+newRemaining {
		return jsonResp(500, map[string]any{"error": "invariant violated", "request_id": requestID}), nil
	}

	now := time.Now().Unix()
	result := map[string]any{"lot_id": lotID, "action": actionDisposition, "stage": "DISTRIBUTING",
		"version": g.version + 1, "returned": newReturned, "disposed": newDisposed, "remaining": newRemaining}
	items := []ddbtypes.TransactWriteItem{
		a.lotUpdateTx(lotID, g.version, g.stage, map[string]ddbtypes.AttributeValue{
			"stage":     sVal("DISTRIBUTING"),
			"returned":  nVal(newReturned),
			"disposed":  nVal(newDisposed),
			"remaining": nVal(newRemaining),
		}),
		a.eventTx(lotID, sub, actionDisposition, "ALLOW", result, now, g.idemKey),
		a.idemTx(lotID, g.idemKey, sub, actionDisposition, result),
	}
	return a.finishWrite(ctx, lotID, sub, g.idemKey, actionDisposition, items, result, g.version, requestID)
}

// ---------------------------------------------------------------- resolve-dispute

func (a *app) handleResolveDispute(ctx context.Context, lotID, sub, role string, body map[string]any, requestID string) (events.APIGatewayV2HTTPResponse, error) {
	g, early, err := a.guarded(ctx, lotID, sub, role, actionResolveDispute, body, stagesResolveDispute, requestID)
	if err != nil {
		return events.APIGatewayV2HTTPResponse{}, err
	}
	if early != nil {
		return *early, nil
	}
	if g.replay != nil {
		return rawResp(200, *g.replay), nil
	}

	lot := g.lot
	if !bAttr(lot, "count_dispute") {
		return jsonResp(409, map[string]any{"error": "no count dispute"}), nil
	}
	reconciled, ok := jsonInt(body["reconciled_received"])
	if !ok {
		return jsonResp(400, map[string]any{"error": "reconciled_received must be an integer"}), nil
	}
	distributed := nAttrOr(lot, "distributed", 0)
	returned := nAttrOr(lot, "returned", 0)
	disposed := nAttrOr(lot, "disposed", 0)
	if status, msg := checkResolve(reconciled, distributed, returned, disposed); status != 0 {
		return jsonResp(status, map[string]any{"error": msg}), nil
	}
	newRemaining := reconciled - distributed - returned - disposed

	now := time.Now().Unix()
	result := map[string]any{"lot_id": lotID, "action": actionResolveDispute, "stage": g.stage,
		"version": g.version + 1, "received": reconciled, "remaining": newRemaining, "count_dispute": false}
	items := []ddbtypes.TransactWriteItem{
		a.lotUpdateTx(lotID, g.version, g.stage, map[string]ddbtypes.AttributeValue{
			"received":      nVal(reconciled),
			"remaining":     nVal(newRemaining),
			"count_dispute": bVal(false),
		}),
		a.eventTx(lotID, sub, actionResolveDispute, "ALLOW", result, now, g.idemKey),
		a.idemTx(lotID, g.idemKey, sub, actionResolveDispute, result),
	}
	return a.finishWrite(ctx, lotID, sub, g.idemKey, actionResolveDispute, items, result, g.version, requestID)
}

// finishWrite commits the transaction and maps the outcome to an HTTP response.
func (a *app) finishWrite(ctx context.Context, lotID, sub, idemKey, action string, items []ddbtypes.TransactWriteItem,
	result any, version int64, requestID string) (events.APIGatewayV2HTTPResponse, error) {

	body, conflict, err := a.commit(ctx, lotID, idemKey, action, items, result)
	if err != nil {
		return events.APIGatewayV2HTTPResponse{}, err
	}
	if conflict {
		return jsonResp(409, map[string]any{"error": "version conflict", "lot_id": lotID}), nil
	}
	logEvent(map[string]any{"msg": "request", "request_id": requestID, "actor": sub, "action": action,
		"lot_id": lotID, "version": version + 1, "decision": "ALLOW", "status": 200})
	return rawResp(200, body), nil
}
