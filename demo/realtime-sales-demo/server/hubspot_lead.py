"""Direct HubSpot enrichment for website leads.

The Zapier zap creates a bare deal (dealname = website field) and drops the
contact info and ad attribution the site sends. This module runs right after
the Zapier post and:

1. Upserts a HubSpot contact (name / email / phone / gclid). If the private
   app token is missing the contacts scope this logs and moves on, so it
   starts working the moment the scope is granted (no redeploy needed).
2. Finds the deal the zap just created and stamps it with the lead details
   and Google Ads attribution (gclid / utm_source / utm_campaign / utm_term),
   then associates the contact when one exists.

Everything is best-effort: a HubSpot hiccup must never fail lead capture.
"""

from __future__ import annotations

import os
import time

import httpx

HUBSPOT_BASE = "https://api.hubapi.com"

# Deal properties that exist in the portal (created Sep 2, 2026).
DEAL_ATTR_PROPS = ("gclid", "utm_source", "utm_campaign", "utm_term")


def _token() -> str:
    return os.environ.get("HUBSPOT_TOKEN", "").strip()


def hubspot_lead_enrichment_configured() -> bool:
    return bool(_token())


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {_token()}",
        "Content-Type": "application/json",
    }


def _log(msg: str) -> None:
    print(f"[hubspot-lead] {msg}", flush=True)


def _upsert_contact(payload: dict[str, str]) -> str:
    """Create or update the contact. Returns the contact id ('' on failure)."""
    email = payload.get("email", "")
    if not email:
        return ""
    properties: dict[str, str] = {"email": email}
    if payload.get("firstName"):
        properties["firstname"] = payload["firstName"]
    if payload.get("lastName"):
        properties["lastname"] = payload["lastName"]
    if payload.get("phoneNumber"):
        properties["phone"] = payload["phoneNumber"]
    if payload.get("website"):
        properties["website"] = payload["website"]
    if payload.get("roleTitle"):
        properties["jobtitle"] = payload["roleTitle"]
    if payload.get("dealership"):
        properties["company"] = payload["dealership"]
    if payload.get("gclid"):
        properties["hs_google_click_id"] = payload["gclid"]

    with httpx.Client(timeout=10.0) as client:
        resp = client.post(
            f"{HUBSPOT_BASE}/crm/v3/objects/contacts",
            headers=_headers(),
            json={"properties": properties},
        )
        if resp.status_code == 201:
            return str(resp.json().get("id", ""))
        if resp.status_code == 409:
            # "Contact already exists. Existing ID: 12345"
            message = resp.json().get("message", "")
            existing_id = message.rsplit(" ", 1)[-1].strip()
            if existing_id.isdigit():
                client.patch(
                    f"{HUBSPOT_BASE}/crm/v3/objects/contacts/{existing_id}",
                    headers=_headers(),
                    json={"properties": properties},
                )
                return existing_id
            return ""
        if resp.status_code == 403:
            _log("contact upsert skipped: token missing contacts scope")
            return ""
        _log(f"contact upsert failed: HTTP {resp.status_code} {resp.text[:200]}")
        return ""


# HubSpot's search index lags record creation by ~10-30s, so the waits are long.
# This only ever runs inside the detached enrichment invocation, never on the
# user-facing form request.
_SEARCH_WAITS = (5, 10, 10, 10, 8)


def _find_recent_deal(dealname: str) -> str:
    """Find the deal the zap just created (waits out HubSpot search-index lag)."""
    if not dealname:
        return ""
    body = {
        "filterGroups": [
            {
                "filters": [
                    {"propertyName": "dealname", "operator": "EQ", "value": dealname},
                    {
                        "propertyName": "createdate",
                        "operator": "GTE",
                        "value": str(int((time.time() - 600) * 1000)),
                    },
                ]
            }
        ],
        "sorts": [{"propertyName": "createdate", "direction": "DESCENDING"}],
        "limit": 1,
    }
    with httpx.Client(timeout=10.0) as client:
        for wait in _SEARCH_WAITS:
            time.sleep(wait)
            resp = client.post(
                f"{HUBSPOT_BASE}/crm/v3/objects/deals/search",
                headers=_headers(),
                json=body,
            )
            if resp.status_code != 200:
                _log(f"deal search failed: HTTP {resp.status_code}")
                return ""
            results = resp.json().get("results", [])
            if results:
                return str(results[0].get("id", ""))
    return ""


def _deal_description(payload: dict[str, str]) -> str:
    lines = [f"Website lead: {payload.get('fullName') or payload.get('email') or 'unknown'}"]
    if payload.get("roleTitle"):
        lines.append(f"Role: {payload['roleTitle']}")
    if payload.get("email"):
        lines.append(f"Email: {payload['email']}")
    if payload.get("phoneNumber"):
        lines.append(f"Phone: {payload['phoneNumber']}")
    if payload.get("website"):
        lines.append(f"Website: {payload['website']}")
    if payload.get("leadSource"):
        lines.append(f"Lead source: {payload['leadSource']}")
    if payload.get("gclid"):
        lines.append(f"gclid: {payload['gclid']}")
    if payload.get("utmCampaign"):
        lines.append(f"Campaign: {payload['utmCampaign']}")
    if payload.get("utmTerm"):
        lines.append(f"Keyword: {payload['utmTerm']}")
    return "\n".join(lines)


def _stamp_deal(deal_id: str, payload: dict[str, str], contact_id: str) -> None:
    properties: dict[str, str] = {"description": _deal_description(payload)}
    attr_source = {
        "gclid": payload.get("gclid", ""),
        "utm_source": payload.get("utmSource", ""),
        "utm_campaign": payload.get("utmCampaign", ""),
        "utm_term": payload.get("utmTerm", ""),
    }
    for prop in DEAL_ATTR_PROPS:
        if attr_source.get(prop):
            properties[prop] = attr_source[prop]

    with httpx.Client(timeout=10.0) as client:
        resp = client.patch(
            f"{HUBSPOT_BASE}/crm/v3/objects/deals/{deal_id}",
            headers=_headers(),
            json={"properties": properties},
        )
        if resp.status_code != 200:
            _log(f"deal patch failed: HTTP {resp.status_code} {resp.text[:200]}")
        if contact_id:
            assoc = client.put(
                f"{HUBSPOT_BASE}/crm/v4/objects/deals/{deal_id}/associations/default/contacts/{contact_id}",
                headers=_headers(),
            )
            if assoc.status_code not in (200, 201):
                _log(f"deal-contact association failed: HTTP {assoc.status_code}")


def enrich_website_lead(payload: dict[str, str]) -> None:
    """Best-effort HubSpot enrichment. Never raises."""
    try:
        if not hubspot_lead_enrichment_configured():
            _log("skipped: HUBSPOT_TOKEN not set")
            return
        contact_id = _upsert_contact(payload)
        deal_id = _find_recent_deal(payload.get("website", "").strip())
        if not deal_id:
            _log(f"deal not found for website={payload.get('website', '')!r}")
            return
        _stamp_deal(deal_id, payload, contact_id)
        _log(
            f"enriched deal {deal_id}"
            + (f" + contact {contact_id}" if contact_id else " (no contact: scope missing)")
        )
    except Exception as exc:
        _log(f"enrichment error (lead still delivered): {exc}")
