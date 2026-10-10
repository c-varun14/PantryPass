// Command apigo is the PantryPass Go API Lambda (API Gateway HTTP API, payload v2).
//
// Port of backend/api.py semantics for the disposition, resolve-dispute and GET /lots
// routes. Trust boundary: the only trusted caller identity is the Cognito JWT authorizer
// claims (sub + cognito:groups). Role, ownership, stock totals and server time are derived
// here; nothing in the request body changes an authorization decision or a stock total.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/verifiedpermissions"
)

type app struct {
	ddb           *dynamodb.Client
	vp            *verifiedpermissions.Client
	lotsTable     string
	eventsTable   string
	policyStoreID string
}

func main() {
	lotsTable := os.Getenv("LOTS_TABLE")
	eventsTable := os.Getenv("EVENTS_TABLE")
	policyStoreID := os.Getenv("POLICY_STORE_ID")
	if lotsTable == "" || eventsTable == "" || policyStoreID == "" {
		log.Fatal("LOTS_TABLE, EVENTS_TABLE and POLICY_STORE_ID must be set")
	}
	cfg, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatalf("aws config: %v", err)
	}
	a := &app{
		ddb:           dynamodb.NewFromConfig(cfg),
		vp:            verifiedpermissions.NewFromConfig(cfg),
		lotsTable:     lotsTable,
		eventsTable:   eventsTable,
		policyStoreID: policyStoreID,
	}
	lambda.Start(a.handle)
}

// jsonResp builds a JSON response with Content-Type application/json.
func jsonResp(status int, v any) events.APIGatewayV2HTTPResponse {
	return rawResp(status, toJSON(v))
}

func rawResp(status int, body string) events.APIGatewayV2HTTPResponse {
	return events.APIGatewayV2HTTPResponse{
		StatusCode: status,
		Headers:    map[string]string{"Content-Type": "application/json"},
		Body:       body,
	}
}

// logEvent writes one JSON line to stdout, as the Python reference does.
func logEvent(fields map[string]any) {
	fields["ts"] = time.Now().Unix()
	b, _ := json.Marshal(fields)
	fmt.Println(string(b))
}

// parseBody decodes the request body into an object. An empty body is {}, a non-object
// JSON value is treated as {}, and invalid JSON reports ok=false.
func parseBody(raw string) (map[string]any, bool) {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}, true
	}
	dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	m, ok := v.(map[string]any)
	if !ok {
		return map[string]any{}, true
	}
	return m, true
}

// awsErrorFields extracts the AWS error code and message without importing smithy-go.
func awsErrorFields(err error) (string, string) {
	var ae interface {
		ErrorCode() string
		ErrorMessage() string
	}
	if errors.As(err, &ae) {
		return ae.ErrorCode(), ae.ErrorMessage()
	}
	return "", err.Error()
}

// handle is the Lambda entry point: auth check, body parse, then routing.
func (a *app) handle(ctx context.Context, ev events.APIGatewayV2HTTPRequest) (events.APIGatewayV2HTTPResponse, error) {
	requestID := ev.RequestContext.RequestID
	claims := map[string]string{}
	if ev.RequestContext.Authorizer != nil && ev.RequestContext.Authorizer.JWT != nil {
		claims = ev.RequestContext.Authorizer.JWT.Claims
	}
	sub := claims["sub"]
	role := roleFromClaims(claims)

	if sub == "" {
		return jsonResp(401, map[string]any{"error": "missing verified subject claim", "request_id": requestID}), nil
	}
	body, ok := parseBody(ev.Body)
	if !ok {
		return jsonResp(400, map[string]any{"error": "body is not JSON", "request_id": requestID}), nil
	}

	method := ev.RequestContext.HTTP.Method
	path := ev.RawPath
	if path == "" {
		path = ev.RequestContext.HTTP.Path
	}
	resp, err := a.route(ctx, method, path, sub, role, body, requestID)
	if err != nil {
		code, detail := awsErrorFields(err)
		logEvent(map[string]any{"msg": "aws_error", "request_id": requestID, "actor": sub, "path": path,
			"error": code, "detail": detail})
		return jsonResp(500, map[string]any{"error": "aws_error", "code": code, "detail": detail, "request_id": requestID}), nil
	}
	return resp, nil
}

// route dispatches the three routes in scope; anything else is 404.
func (a *app) route(ctx context.Context, method, path, sub, role string, body map[string]any, requestID string) (events.APIGatewayV2HTTPResponse, error) {
	parts := []string{}
	for _, p := range strings.Split(path, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}
	switch {
	case method == "GET" && len(parts) == 1 && parts[0] == "lots":
		return a.handleGetLots(ctx, sub, role, requestID)
	case method == "POST" && len(parts) == 3 && parts[0] == "lots" && parts[2] == "disposition":
		return a.handleDisposition(ctx, parts[1], sub, role, body, requestID)
	case method == "POST" && len(parts) == 3 && parts[0] == "lots" && parts[2] == "resolve-dispute":
		return a.handleResolveDispute(ctx, parts[1], sub, role, body, requestID)
	}
	return jsonResp(404, map[string]any{"error": "not found"}), nil
}
