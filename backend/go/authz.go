package main

import (
	"context"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/verifiedpermissions"
	vptypes "github.com/aws/aws-sdk-go-v2/service/verifiedpermissions/types"
)

const policyNS = "PantryPass"

// parseGroups turns the cognito:groups claim ("[donor]", "[donor,receiver]" or "donor")
// into a slice of group names.
func parseGroups(raw string) []string {
	var groups []string
	for _, g := range strings.Split(strings.Trim(raw, "[]"), ",") {
		if g = strings.TrimSpace(g); g != "" {
			groups = append(groups, g)
		}
	}
	return groups
}

// roleFromGroups picks the role by precedence donor > receiver > coordinator, else "user".
func roleFromGroups(groups []string) string {
	has := func(want string) bool {
		for _, g := range groups {
			if g == want {
				return true
			}
		}
		return false
	}
	switch {
	case has("donor"):
		return "donor"
	case has("receiver"):
		return "receiver"
	case has("coordinator"):
		return "coordinator"
	}
	return "user"
}

// roleFromClaims derives the caller role from the verified JWT claims only.
func roleFromClaims(claims map[string]string) string {
	return roleFromGroups(parseGroups(claims["cognito:groups"]))
}

func userRef(id string) vptypes.AttributeValue {
	return &vptypes.AttributeValueMemberEntityIdentifier{Value: vptypes.EntityIdentifier{
		EntityType: aws.String(policyNS + "::User"),
		EntityId:   aws.String(id),
	}}
}

// vpEntities builds the entity list: the caller, the lot's donor and receiver (when they
// are other users), and the lot itself with donor/receiver attributes.
func vpEntities(sub, role string, lot item) vptypes.EntitiesDefinition {
	users := []vptypes.EntityItem{{
		Identifier: &vptypes.EntityIdentifier{EntityType: aws.String(policyNS + "::User"), EntityId: aws.String(sub)},
		Attributes: map[string]vptypes.AttributeValue{"role": &vptypes.AttributeValueMemberString{Value: role}},
	}}
	var entities []vptypes.EntityItem
	if lot != nil {
		donor := sAttr(lot, "donor_sub")
		recv := sAttr(lot, "receiver_sub")
		for _, p := range []struct{ uid, role string }{{donor, "donor"}, {recv, "receiver"}} {
			if p.uid != "" && p.uid != sub {
				users = append(users, vptypes.EntityItem{
					Identifier: &vptypes.EntityIdentifier{EntityType: aws.String(policyNS + "::User"), EntityId: aws.String(p.uid)},
					Attributes: map[string]vptypes.AttributeValue{"role": &vptypes.AttributeValueMemberString{Value: p.role}},
				})
			}
		}
		entities = append(entities, vptypes.EntityItem{
			Identifier: &vptypes.EntityIdentifier{EntityType: aws.String(policyNS + "::Lot"), EntityId: aws.String(sAttr(lot, "lot_id"))},
			Attributes: map[string]vptypes.AttributeValue{
				"donor":    userRef(donor),
				"receiver": userRef(recv),
			},
		})
	}
	return &vptypes.EntitiesDefinitionMemberEntityList{Value: append(users, entities...)}
}

// vpAuthorize returns true only for decision ALLOW with no evaluation errors.
func (a *app) vpAuthorize(ctx context.Context, sub, role, action, lotID string, lot item) (bool, error) {
	out, err := a.vp.IsAuthorized(ctx, &verifiedpermissions.IsAuthorizedInput{
		PolicyStoreId: aws.String(a.policyStoreID),
		Principal:     &vptypes.EntityIdentifier{EntityType: aws.String(policyNS + "::User"), EntityId: aws.String(sub)},
		Action:        &vptypes.ActionIdentifier{ActionType: aws.String(policyNS + "::Action"), ActionId: aws.String(action)},
		Resource:      &vptypes.EntityIdentifier{EntityType: aws.String(policyNS + "::Lot"), EntityId: aws.String(lotID)},
		Entities:      vpEntities(sub, role, lot),
	})
	if err != nil {
		return false, err
	}
	return out.Decision == vptypes.DecisionAllow && len(out.Errors) == 0, nil
}
