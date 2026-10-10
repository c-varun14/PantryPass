package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	ddbtypes "github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// item is a raw DynamoDB item as returned by the SDK.
type item = map[string]ddbtypes.AttributeValue

// ---------------------------------------------------------------- attribute helpers

func sVal(v string) ddbtypes.AttributeValue { return &ddbtypes.AttributeValueMemberS{Value: v} }
func nVal(v int64) ddbtypes.AttributeValue {
	return &ddbtypes.AttributeValueMemberN{Value: strconv.FormatInt(v, 10)}
}
func bVal(v bool) ddbtypes.AttributeValue { return &ddbtypes.AttributeValueMemberBOOL{Value: v} }

// sAttr returns the string attribute or "" when missing or not a string.
func sAttr(it item, key string) string {
	if v, ok := it[key].(*ddbtypes.AttributeValueMemberS); ok {
		return v.Value
	}
	return ""
}

// nAttr returns the numeric attribute; ok is false when missing or not parseable.
func nAttr(it item, key string) (int64, bool) {
	if v, ok := it[key].(*ddbtypes.AttributeValueMemberN); ok {
		n, err := strconv.ParseInt(v.Value, 10, 64)
		return n, err == nil
	}
	return 0, false
}

// nAttrOr returns the numeric attribute or def when missing.
func nAttrOr(it item, key string, def int64) int64 {
	if n, ok := nAttr(it, key); ok {
		return n
	}
	return def
}

// bAttr returns the boolean attribute or false when missing.
func bAttr(it item, key string) bool {
	if v, ok := it[key].(*ddbtypes.AttributeValueMemberBOOL); ok {
		return v.Value
	}
	return false
}

// public converts a raw item to a plain map, never exposing task_token.
func public(it item) map[string]any {
	out := make(map[string]any, len(it))
	for k, v := range it {
		if k == "task_token" {
			continue
		}
		switch t := v.(type) {
		case *ddbtypes.AttributeValueMemberS:
			out[k] = t.Value
		case *ddbtypes.AttributeValueMemberN:
			if n, err := strconv.ParseInt(t.Value, 10, 64); err == nil {
				out[k] = n
			}
		case *ddbtypes.AttributeValueMemberBOOL:
			out[k] = t.Value
		case *ddbtypes.AttributeValueMemberNULL:
			out[k] = nil
		}
	}
	return out
}

// ---------------------------------------------------------------- JSON helpers

func toJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return `{"error":"marshal failed"}`
	}
	return string(b)
}

// jsonInt parses an integer the way Python's int() does for the body values we accept.
func jsonInt(v any) (int64, bool) {
	switch t := v.(type) {
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return i, true
		}
		f, err := t.Float64()
		if err != nil {
			return 0, false
		}
		return int64(f), true
	case string:
		i, err := strconv.ParseInt(strings.TrimSpace(t), 10, 64)
		return i, err == nil
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// optionalInt returns (0, true) when the key is absent or null, otherwise the parsed value.
func optionalInt(body map[string]any, key string) (int64, bool) {
	if body[key] == nil {
		return 0, true
	}
	return jsonInt(body[key])
}

// ---------------------------------------------------------------- lots

func (a *app) getLot(ctx context.Context, lotID string) (item, error) {
	out, err := a.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(a.lotsTable),
		Key:            item{"lot_id": sVal(lotID)},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	if len(out.Item) == 0 {
		return nil, nil
	}
	return out.Item, nil
}

func (a *app) scanLots(ctx context.Context) ([]item, error) {
	var all []item
	var start map[string]ddbtypes.AttributeValue
	for {
		out, err := a.ddb.Scan(ctx, &dynamodb.ScanInput{
			TableName:         aws.String(a.lotsTable),
			ExclusiveStartKey: start,
		})
		if err != nil {
			return nil, err
		}
		all = append(all, out.Items...)
		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		start = out.LastEvaluatedKey
	}
	return all, nil
}

// visibleLots applies the per-role visibility rule for GET /lots and sorts newest first.
func visibleLots(lots []item, role, sub string) []item {
	var out []item
	for _, lot := range lots {
		switch role {
		case "donor":
			if sAttr(lot, "donor_sub") != sub {
				continue
			}
		case "receiver":
			if sAttr(lot, "receiver_sub") != sub {
				continue
			}
		case "coordinator":
		default:
			continue
		}
		out = append(out, lot)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return nAttrOr(out[i], "created_epoch", 0) > nAttrOr(out[j], "created_epoch", 0)
	})
	return out
}

// lotUpdateTx builds a version+stage conditional update of the lot. sets maps attribute
// names to values; version is bumped by one.
func (a *app) lotUpdateTx(lotID string, version int64, expectedStage string, sets map[string]ddbtypes.AttributeValue) ddbtypes.TransactWriteItem {
	names := map[string]string{"#version": "version", "#stage": "stage"}
	values := map[string]ddbtypes.AttributeValue{
		":newversion": nVal(version + 1),
		":v":          nVal(version),
		":st":         sVal(expectedStage),
	}
	keys := make([]string, 0, len(sets))
	for k := range sets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	assignments := make([]string, 0, len(keys)+1)
	for _, k := range keys {
		names["#"+k] = k
		values[":"+k] = sets[k]
		assignments = append(assignments, "#"+k+" = :"+k)
	}
	assignments = append(assignments, "#version = :newversion")
	return ddbtypes.TransactWriteItem{Update: &ddbtypes.Update{
		TableName:                 aws.String(a.lotsTable),
		Key:                       item{"lot_id": sVal(lotID)},
		UpdateExpression:          aws.String("SET " + strings.Join(assignments, ", ")),
		ConditionExpression:       aws.String("#version = :v AND #stage = :st"),
		ExpressionAttributeNames:  names,
		ExpressionAttributeValues: values,
	}}
}

// ---------------------------------------------------------------- events and idempotency

func newEventID(now int64) string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%012d#%s", now, hex.EncodeToString(b[:]))
}

func (a *app) rejectEvent(ctx context.Context, lotID, sub, action, requestID string) {
	now := time.Now().Unix()
	_, err := a.ddb.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(a.eventsTable),
		Item: item{
			"lot_id":     sVal(lotID),
			"event_id":   sVal(newEventID(now)),
			"actor":      sVal(sub),
			"action":     sVal(action),
			"decision":   sVal("DENY"),
			"source":     sVal("VerifiedPermissions"),
			"request_id": sVal(requestID),
			"ts":         nVal(now),
		},
	})
	if err != nil { // logging a rejection must never break the 403
		logEvent(map[string]any{"msg": "reject_event_failed", "error": err.Error()})
	}
}

func (a *app) eventTx(lotID, sub, action, decision string, result any, now int64, idemKey string) ddbtypes.TransactWriteItem {
	it := item{
		"lot_id":   sVal(lotID),
		"event_id": sVal(newEventID(now)),
		"actor":    sVal(sub),
		"action":   sVal(action),
		"decision": sVal(decision),
		"result":   sVal(toJSON(result)),
		"ts":       nVal(now),
	}
	if idemKey != "" {
		it["idem_key"] = sVal(idemKey)
	}
	return ddbtypes.TransactWriteItem{Put: &ddbtypes.Put{TableName: aws.String(a.eventsTable), Item: it}}
}

func (a *app) idemTx(lotID, idemKey, sub, action string, result any) ddbtypes.TransactWriteItem {
	return ddbtypes.TransactWriteItem{Put: &ddbtypes.Put{
		TableName: aws.String(a.eventsTable),
		Item: item{
			"lot_id":   sVal(lotID),
			"event_id": sVal("IDEM#" + idemKey),
			"actor":    sVal(sub),
			"action":   sVal(action),
			"decision": sVal("ALLOW"),
			"result":   sVal(toJSON(result)),
			"ts":       nVal(time.Now().Unix()),
		},
		ConditionExpression: aws.String("attribute_not_exists(event_id)"),
	}}
}

func (a *app) idemGet(ctx context.Context, lotID, idemKey string) (item, error) {
	out, err := a.ddb.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(a.eventsTable),
		Key:            item{"lot_id": sVal(lotID), "event_id": sVal("IDEM#" + idemKey)},
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, err
	}
	if len(out.Item) == 0 {
		return nil, nil
	}
	return out.Item, nil
}

// transact runs TransactWriteItems. canceled is true for a TransactionCanceledException
// (version/stage condition or idempotency marker collision); other errors are returned.
func (a *app) transact(ctx context.Context, items []ddbtypes.TransactWriteItem) (bool, error) {
	_, err := a.ddb.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
	if err == nil {
		return false, nil
	}
	var tce *ddbtypes.TransactionCanceledException
	if errors.As(err, &tce) {
		return true, nil
	}
	return false, err
}

// commit writes the transaction. It returns the JSON body to send with 200, conflict=true
// for a real version/stage conflict, or an error for AWS failures. A committed idem key
// with the same action replays its stored body.
func (a *app) commit(ctx context.Context, lotID, idemKey, action string, items []ddbtypes.TransactWriteItem, response any) (string, bool, error) {
	if idemKey != "" {
		ex, err := a.idemGet(ctx, lotID, idemKey)
		if err != nil {
			return "", false, err
		}
		if ex != nil && sAttr(ex, "action") == action {
			return sAttr(ex, "result"), false, nil
		}
	}
	canceled, err := a.transact(ctx, items)
	if err != nil {
		return "", false, err
	}
	if !canceled {
		return toJSON(response), false, nil
	}
	if idemKey != "" {
		ex, err := a.idemGet(ctx, lotID, idemKey)
		if err != nil {
			return "", false, err
		}
		if ex != nil && sAttr(ex, "action") == action {
			return sAttr(ex, "result"), false, nil
		}
	}
	return "", true, nil
}
