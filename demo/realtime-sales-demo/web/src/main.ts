import "./style.css";
import "./landing-hero.css";
import "./cal-minimal-theme.css";
import "./landing-responsive.css";
import hammerTermsFragment from "./legal/hammer-terms-fragment.html?raw";
import hammerPrivacyFragment from "./legal/hammer-privacy-fragment.html?raw";
import type { VoiceConversation as Conversation } from "@elevenlabs/client";
import { installElevenLabsBrowserCompatShims } from "./elevenlabs-browser-compat";

installElevenLabsBrowserCompatShims();

/**
 * Lazy-load the ElevenLabs voice SDK so it is split out of the critical landing
 * bundle — it is only needed when a visitor actually starts a voice call, not on
 * first paint. Cached so repeated calls (prewarm + actual start) share one fetch.
 */
let _elevenLabsClientPromise: Promise<typeof import("@elevenlabs/client")> | null =
  null;
function loadElevenLabsClient(): Promise<typeof import("@elevenlabs/client")> {
  if (!_elevenLabsClientPromise) {
    _elevenLabsClientPromise = import("@elevenlabs/client");
  }
  return _elevenLabsClientPromise;
}
import {
  startVoiceAudioVisualizer,
  type VoiceVisualizerHandle,
} from "./voice-audio-visualizer";
import { HAMMER_SALES_INSTRUCTIONS } from "./hammer-sales-instructions";
import { captureLeadAttribution, leadAttributionFields } from "./lead-attribution";

captureLeadAttribution();

/** Voice scenario — Hammer sales instructions only. */
type VoiceScenario = "hammer";

type AgentMode =
  | "general"
  | "support"
  | "leads"
  | "receptionist"
  | "survey"
  | "custom";

/** Realtime model — must match REALTIME_SALES_MODEL on the server. */
const REALTIME_MODEL: string =
  (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
    .VITE_REALTIME_MODEL?.trim() || "gpt-realtime-2";

function envTruthy(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** hammer-finalsite / hammertime production — keep full hero visible during live browser voice calls. */
const IS_FINAL_PRODUCTION_SITE = (() => {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname.toLowerCase();
  return (
    host === "hammer-finalsite.vercel.app" ||
    host.endsWith("-hammer-finalsite.vercel.app") ||
    host === "www.hammertime.com" ||
    host === "hammertime.com"
  );
})();

/**
 * Playground parity profile: neutral minimal prompt, softer VAD, omit reasoning knob,
 * no `search_wiki` (isolates persona + tool cadence vs BASE_INSTRUCTIONS). Toggle: `VITE_REALTIME_PLAYGROUND_PARITY=1`.
 */
const REALTIME_PLAYGROUND_PARITY = envTruthy(
  (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
    .VITE_REALTIME_PLAYGROUND_PARITY,
);

/** Sign-in destination. Override: `VITE_SIGN_IN_URL` in `.env`. */
const SIGN_IN_URL: string =
  (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
    .VITE_SIGN_IN_URL?.trim() ||
  "https://www2.hammer-corp.com/session/new";

/** HubSpot support form — footer "Contact Support" panel. Override region: `VITE_HUBSPOT_FORM_REGION`. */
const HUBSPOT_PORTAL_ID = "3355079";
const HUBSPOT_SUPPORT_FORM_ID = "7113d858-622b-4df3-a6f3-4ecc5b7c0c36";
const HUBSPOT_FORM_REGION =
  (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
    .VITE_HUBSPOT_FORM_REGION?.trim() || "na1";

type HubSpotFormsApi = {
  forms: {
    create: (opts: {
      region: string;
      portalId: string;
      formId: string;
      target: string;
    }) => void;
  };
};

let hubspotFormsScriptPromise: Promise<HubSpotFormsApi> | null = null;

function loadHubSpotForms(): Promise<HubSpotFormsApi> {
  const w = window as Window & { hbspt?: HubSpotFormsApi };
  if (w.hbspt?.forms) return Promise.resolve(w.hbspt);
  if (hubspotFormsScriptPromise) return hubspotFormsScriptPromise;
  hubspotFormsScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://js.hsforms.net/forms/embed/v2.js";
    s.charset = "utf-8";
    s.async = true;
    s.onload = () => {
      if (w.hbspt?.forms) resolve(w.hbspt);
      else reject(new Error("HubSpot forms API unavailable"));
    };
    s.onerror = () => reject(new Error("Could not load HubSpot forms"));
    document.head.appendChild(s);
  });
  return hubspotFormsScriptPromise;
}

async function mountHubSpotSupportForm(container: HTMLElement | null): Promise<void> {
  if (!container || container.dataset.mounted === "1") return;
  try {
    const hbspt = await loadHubSpotForms();
    hbspt.forms.create({
      region: HUBSPOT_FORM_REGION,
      portalId: HUBSPOT_PORTAL_ID,
      formId: HUBSPOT_SUPPORT_FORM_ID,
      target: "#hubspotSupportForm",
    });
    container.dataset.mounted = "1";
  } catch (err) {
    console.error("[hubspot support form]", err);
  }
}

/**
 * Human sales line — a real rep answers this number (no AI/voice bot).
 * Override display/dial copy via the `rt_sales_phone_*` keys; defaults below.
 */
const SALES_PHONE_DISPLAY = "(512) 886-9117";
const SALES_PHONE_TEL = "+15128869117";

function salesPhone(): { display: string; tel: string; href: string } {
  const display = copy("rt_sales_phone_display", SALES_PHONE_DISPLAY).trim() || SALES_PHONE_DISPLAY;
  const tel =
    (copy("rt_sales_phone_tel", SALES_PHONE_TEL).trim() || SALES_PHONE_TEL).replace(/[^\d+]/g, "") ||
    SALES_PHONE_TEL;
  return { display, tel, href: `tel:${tel}` };
}

/**
 * Live voice demo retired (Aug 2026) — both flags stay false so no voice UI
 * renders and the ElevenLabs SDK is never fetched (was ignoring
 * VITE_ENABLE_BROWSER_VOICE on purpose; flip these to re-enable).
 */
const BROWSER_VOICE_ENABLED = false;
const NAV_PANEL_VOICE_ENABLED = false;
/** Home product cards — same browser voice as nav panels (not gated on VITE_ENABLE_BROWSER_VOICE). */
const PRODUCT_COL_VOICE_ENABLED = NAV_PANEL_VOICE_ENABLED || BROWSER_VOICE_ENABLED;
const NAV_PANEL_FOOT_TAP_MS = 340;

const REDUCE_MOTION =
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Phones / Save-Data: skip idle voice SDK fetch. Voice buttons still prewarm on tap. */
function preferLightMobileNetwork(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } })
    .connection;
  if (connection?.saveData) return true;
  return window.matchMedia("(max-width: 719px), (pointer: coarse)").matches;
}

const REVIEWS_YOUTUBE_EMBED =
  "https://www.youtube.com/embed/kcQufq_YC_Y?autoplay=1&mute=1&controls=0&modestbranding=1&playsinline=1&rel=0&iv_load_policy=3&disablekb=1&fs=0";
const navPanelFootHintAnims = new WeakMap<Element, Animation>();

function cancelNavPanelFootHint(btn: HTMLElement | null | undefined): void {
  if (!btn) return;
  for (const el of btn.querySelectorAll<HTMLElement>(".nav-panel__foot-signal, .nav-panel__foot-orbit")) {
    navPanelFootHintAnims.get(el)?.cancel();
    navPanelFootHintAnims.delete(el);
  }
}

function navPanelFootMotionReduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function startNavPanelFootIdleHint(btn: HTMLElement | null | undefined): void {
  if (!btn || (btn instanceof HTMLButtonElement && btn.disabled)) return;
  if (navPanelFootMotionReduced()) return;
  if (btn.classList.contains("is-voice-live") || btn.classList.contains("is-voice-connecting")) return;

  cancelNavPanelFootHint(btn);

  const orbit = btn.querySelector<HTMLElement>(".nav-panel__foot-orbit");
  if (orbit && typeof orbit.animate === "function") {
    navPanelFootHintAnims.set(
      orbit,
      orbit.animate(
        [
          { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(201, 30, 30, 0.42)" },
          { transform: "scale(1.07)", boxShadow: "0 0 0 11px rgba(201, 30, 30, 0)" },
          { transform: "scale(1)", boxShadow: "0 0 0 0 rgba(201, 30, 30, 0)" },
        ],
        { duration: 2200, easing: "ease-in-out", iterations: Infinity },
      ),
    );
  }

  const signal = btn.querySelector<HTMLElement>(".nav-panel__foot-signal");
  if (signal && typeof signal.animate === "function") {
    navPanelFootHintAnims.set(
      signal,
      signal.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(1.05)" },
          { transform: "scale(1)" },
        ],
        { duration: 2200, easing: "ease-in-out", iterations: Infinity },
      ),
    );
  }
}

function startNavPanelFootConnectingHint(btn: HTMLElement | null | undefined): void {
  if (!btn) return;
  if (navPanelFootMotionReduced()) return;
  if (!btn.classList.contains("is-voice-connecting")) return;

  cancelNavPanelFootHint(btn);

  const orbit = btn.querySelector<HTMLElement>(".nav-panel__foot-orbit");
  if (orbit && typeof orbit.animate === "function") {
    navPanelFootHintAnims.set(
      orbit,
      orbit.animate(
        [
          { transform: "scale(1) rotate(0deg)", boxShadow: "0 0 0 0 rgba(217, 119, 6, 0.5)" },
          { transform: "scale(1.06) rotate(180deg)", boxShadow: "0 0 0 12px rgba(217, 119, 6, 0)" },
          { transform: "scale(1) rotate(360deg)", boxShadow: "0 0 0 0 rgba(217, 119, 6, 0)" },
        ],
        { duration: 1300, easing: "linear", iterations: Infinity },
      ),
    );
  }

  const signal = btn.querySelector<HTMLElement>(".nav-panel__foot-signal");
  if (signal && typeof signal.animate === "function") {
    navPanelFootHintAnims.set(
      signal,
      signal.animate(
        [
          { transform: "scale(1)", opacity: "1" },
          { transform: "scale(1.06)", opacity: "0.88" },
          { transform: "scale(1)", opacity: "1" },
        ],
        { duration: 1300, easing: "ease-in-out", iterations: Infinity },
      ),
    );
  }
}

function startNavPanelFootLiveHint(btn: HTMLElement | null | undefined): void {
  if (!btn || (btn instanceof HTMLButtonElement && btn.disabled)) return;
  if (navPanelFootMotionReduced()) return;
  if (!btn.classList.contains("is-voice-live")) return;

  cancelNavPanelFootHint(btn);

  const orbit = btn.querySelector<HTMLElement>(".nav-panel__foot-orbit");
  if (orbit && typeof orbit.animate === "function") {
    navPanelFootHintAnims.set(
      orbit,
      orbit.animate(
        [
          {
            transform: "scale(1)",
            boxShadow: "0 0 0 3px rgba(13, 159, 110, 0.28), 0 0 14px rgba(13, 159, 110, 0.35)",
          },
          {
            transform: "scale(1.08)",
            boxShadow: "0 0 0 10px rgba(13, 159, 110, 0.08), 0 0 22px rgba(13, 159, 110, 0.55)",
          },
          {
            transform: "scale(1)",
            boxShadow: "0 0 0 3px rgba(13, 159, 110, 0.28), 0 0 14px rgba(13, 159, 110, 0.35)",
          },
        ],
        { duration: 1700, easing: "ease-in-out", iterations: Infinity },
      ),
    );
  }

  const signal = btn.querySelector<HTMLElement>(".nav-panel__foot-signal");
  if (signal && typeof signal.animate === "function") {
    navPanelFootHintAnims.set(
      signal,
      signal.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(1.06)" },
          { transform: "scale(1)" },
        ],
        { duration: 1700, easing: "ease-in-out", iterations: Infinity },
      ),
    );
  }
}

function syncNavPanelFootHint(btn: HTMLElement | null | undefined): void {
  if (!btn) return;
  if (btn.classList.contains("is-voice-live")) {
    startNavPanelFootLiveHint(btn);
  } else if (btn.classList.contains("is-voice-connecting")) {
    startNavPanelFootConnectingHint(btn);
  } else {
    startNavPanelFootIdleHint(btn);
  }
}

function playNavPanelFootTapFeedback(btn: HTMLElement | null | undefined): void {
  if (!btn || (btn instanceof HTMLButtonElement && btn.disabled)) return;

  cancelNavPanelFootHint(btn);

  btn.classList.remove("is-tap-active");
  void btn.offsetWidth;
  btn.classList.add("is-tap-active");
  window.setTimeout(() => {
    btn.classList.remove("is-tap-active");
    syncNavPanelFootHint(btn);
  }, NAV_PANEL_FOOT_TAP_MS + 60);

  const reducedMotion = navPanelFootMotionReduced();
  const duration = reducedMotion ? 140 : NAV_PANEL_FOOT_TAP_MS;
  const easing = "cubic-bezier(0.22, 1, 0.36, 1)";

  if (typeof btn.animate === "function") {
    btn.animate(
      [
        { transform: "translateY(0) scale(1)" },
        { transform: "translateY(2px) scale(0.965)" },
        { transform: "translateY(0) scale(1)" },
      ],
      { duration, easing, fill: "none" },
    );
  }

  const signal = btn.querySelector<HTMLElement>(".nav-panel__foot-signal");
  if (signal && typeof signal.animate === "function") {
    signal.animate(
      [
        { transform: "scale(1)" },
        { transform: "scale(0.82)" },
        { transform: "scale(1)" },
      ],
      { duration, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)", fill: "none" },
    );
  }

  const orbit = btn.querySelector<HTMLElement>(".nav-panel__foot-orbit");
  if (orbit && typeof orbit.animate === "function") {
    const isLive = orbit.classList.contains("is-live");
    const isConnecting = orbit.classList.contains("is-connecting");
    const ring = isLive
      ? "rgba(13, 159, 110, 0.55)"
      : isConnecting
        ? "rgba(217, 119, 6, 0.5)"
        : "rgba(201, 30, 30, 0.55)";
    const ringFade = isLive
      ? "rgba(13, 159, 110, 0)"
      : isConnecting
        ? "rgba(217, 119, 6, 0)"
        : "rgba(201, 30, 30, 0)";

    orbit.animate(
      [
        { transform: "scale(1)", boxShadow: `0 0 0 0 ${ring}` },
        { transform: "scale(0.84)", boxShadow: `0 0 0 14px ${ringFade}` },
        { transform: "scale(1)", boxShadow: `0 0 0 0 ${ringFade}` },
      ],
      { duration, easing, fill: "none" },
    );
  }
}

function bindNavPanelFootTapFeedback(btn: HTMLElement | null | undefined): void {
  if (!btn) return;
  const run = (e: Event) => {
    if (e instanceof PointerEvent && e.button !== 0) return;
    playNavPanelFootTapFeedback(btn);
  };
  btn.addEventListener("pointerdown", run);
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      playNavPanelFootTapFeedback(btn);
    }
  });
}

async function delayForTapFeedback(ms?: number): Promise<void> {
  if (!ms || ms <= 0) return;
  await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}


let healthDemoPhone: { display: string; tel: string } = { display: "", tel: "" };
let telephonyOutbound: { enabled: boolean; apiUrl: string } = { enabled: false, apiUrl: "" };

type OutboundCallUiState = "idle" | "calling" | "answered" | "error";
let outboundCallUi: OutboundCallUiState = "idle";
let outboundCallCid = "";
let outboundCallError = "";
let outboundPhoneDraft = "";
let outboundConsentChecked = false;
let outboundPollTimer: ReturnType<typeof setInterval> | null = null;

function outboundCallMePrimary(): boolean {
  // Hannah voice demo retired — never surface the outbound "call me" flow,
  // even if the backend reports outbound telephony as enabled.
  return false;
}

function outboundCallbackPollUrl(cid: string): string {
  const base = telephonyOutbound.apiUrl.replace(/\/api\/telephony\/callback\/?$/, "");
  return base ? `${base}/api/telephony/callback/${encodeURIComponent(cid)}` : `/api/telephony/callback/${encodeURIComponent(cid)}`;
}

function stopOutboundPoll(): void {
  if (outboundPollTimer !== null) {
    clearInterval(outboundPollTimer);
    outboundPollTimer = null;
  }
}

function callMeModalHint(): string {
  const phone =
    demoPhoneInfo().display ||
    copyUntracked("rt_demo_phone_display", "").trim() ||
    copyUntracked("rt_demo_phone", "").trim() ||
    "our demo line";
  const template = copy(
    "rt_call_me_modal_hint",
    "Expect a call from {phone}. AI voice · carrier rates may apply · hang up to opt out.",
  );
  return template.includes("{phone}")
    ? template.replace(/\{phone\}/g, phone)
    : template;
}

function outboundStatusMessage(): string {
  if (outboundCallUi === "calling") {
    return copy("rt_call_me_status_calling", "Calling your phone… Answer to start the challenge.");
  }
  if (outboundCallUi === "answered") {
    return copy("rt_call_me_status_answered", "You're connected. Talk to Hannah on your phone.");
  }
  if (outboundCallUi === "error" && outboundCallError) {
    return outboundCallError;
  }
  return "";
}

async function pollOutboundCallStatus(cid: string): Promise<void> {
  try {
    const res = await fetch(outboundCallbackPollUrl(cid), {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { status?: string };
    const status = (data.status || "").toLowerCase();
    if (status === "answered" || status === "in-progress" || status === "completed") {
      outboundCallUi = "answered";
      stopOutboundPoll();
      voiceUiRefresh?.();
      return;
    }
    if (["failed", "busy", "no-answer", "canceled", "cancelled"].includes(status)) {
      outboundCallUi = "error";
      outboundCallError = copy(
        "rt_call_me_error_unreachable",
        "We couldn't reach that number. Check the number and try again.",
      );
      stopOutboundPoll();
      voiceUiRefresh?.();
    }
  } catch {
    /* keep polling */
  }
}

function startOutboundPoll(cid: string): void {
  stopOutboundPoll();
  void pollOutboundCallStatus(cid);
  outboundPollTimer = setInterval(() => {
    void pollOutboundCallStatus(cid);
  }, 2_500);
}

async function submitCallMeForm(phone: string, consent: boolean): Promise<void> {
  const postUrl = telephonyOutbound.apiUrl || "/api/telephony/callback";
  callMeModalOpen = true;
  outboundCallUi = "calling";
  outboundCallError = "";
  outboundCallCid = "";
  voiceUiRefresh?.();
  try {
    const res = await fetch(postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, consent }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => ({}))) as {
      cid?: string;
      detail?: string;
      ok?: boolean;
    };
    if (!res.ok) {
      throw new Error(
        typeof data.detail === "string" && data.detail.trim()
          ? data.detail
          : `Request failed (${res.status})`,
      );
    }
    const cid = (data.cid || "").trim();
    if (!cid) throw new Error("Server did not return a callback id.");
    outboundCallCid = cid;
    startOutboundPoll(cid);
  } catch (err) {
    outboundCallUi = "error";
    outboundCallError =
      extractVoiceErrorMessage(err) ||
      copy("rt_call_me_error_generic", "Could not start the call. Try again in a moment.");
    stopOutboundPoll();
    voiceUiRefresh?.();
  }
}

function formatUsPhoneDisplay(digits: string): string {
  const d = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (d.length === 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  return digits;
}

function demoPhoneInfo(): { display: string; tel: string; href: string } {
  const envPhone = (
    import.meta as ImportMeta & { env: Record<string, string | undefined> }
  ).env.VITE_DEMO_PHONE_NUMBER?.trim();
  // Prefer /api/health (Vercel/Fly env) over wiki so the dial link matches deployed Twilio config.
  const display =
    healthDemoPhone.display ||
    copyUntracked("rt_demo_phone_display", "").trim() ||
    copyUntracked("rt_demo_phone", "").trim() ||
    envPhone ||
    "";
  const telRaw =
    healthDemoPhone.tel ||
    copyUntracked("rt_demo_phone_tel", "").trim() ||
    envPhone ||
    display;
  const rawDigits = telRaw.replace(/\D/g, "");
  // US numbers need the country code: a 10-digit env/wiki value would produce
  // an invalid href like tel:+7372056753 (+7 is not the US), which the
  // telephony API later "corrects" — triggering a needless full re-render.
  const digits = rawDigits.length === 10 ? `1${rawDigits}` : rawDigits;
  const href = digits ? `tel:+${digits}` : "";
  const shown = display || (digits ? formatUsPhoneDisplay(digits) : "");
  return { display: shown, tel: digits, href };
}

function voiceErrorDetailFallback(): string {
  return copy(
    "rt_nav_panel_foot_hint_error",
    "Voice could not start. Check microphone access and try again.",
  );
}

function extractVoiceErrorMessage(ev: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (ev instanceof Error) return ev.message.trim();
  if (typeof ev === "string") return ev.trim();
  if (typeof ev === "object" && ev !== null) {
    const o = ev as Record<string, unknown>;
    if ("error" in o && o.error !== null && o.error !== ev) {
      const nested = extractVoiceErrorMessage(o.error, depth + 1);
      if (nested) return nested;
    }
    for (const key of ["message", "detail", "reason", "code", "name"]) {
      const val = o[key];
      if (typeof val === "string" && val.trim()) return val.trim();
    }
  }
  return "";
}

function applyVoiceConnectErrorDetail(raw: unknown): void {
  const next = voiceConnectErrorMessage(extractVoiceErrorMessage(raw));
  const fallback = voiceErrorDetailFallback();
  if (next !== fallback) {
    errorDetail = next;
    return;
  }
  if (!errorDetail.trim() || errorDetail === fallback) {
    errorDetail = next;
  }
}

function voiceConnectErrorMessage(rawMsg: string): string {
  const msg = (rawMsg ?? "").trim();
  if (!msg || msg === "undefined" || msg === "null") {
    return voiceErrorDetailFallback();
  }
  if (/insufficient_quota/i.test(msg)) {
    return copy(
      "rt_error_openai_quota",
      "OpenAI API quota exceeded for this site. Add billing or credits at platform.openai.com, update OPENAI_API_KEY on Vercel, then redeploy production.",
    );
  }
  if (/HTTP 429|rate limit|Too Many Requests/i.test(msg)) {
    return copy(
      "rt_error_el_rate_limit",
      "Voice is temporarily busy (ElevenLabs rate limit). Wait 30-60 seconds, then tap again.",
    );
  }
  if (/NotSupportedError|Not supported/i.test(msg)) {
    return copy(
      "rt_error_mic_not_supported",
      "Your browser blocked an advanced microphone setting. Try Chrome or Edge, allow mic access, then tap again.",
    );
  }
  if (/setRemoteDescription|SessionDescription.*Expect line: v=/i.test(msg)) {
    if (/insufficient_quota/i.test(msg)) {
      return copy(
        "rt_error_openai_quota",
        "OpenAI API quota exceeded for this site. Add billing or credits at platform.openai.com, update OPENAI_API_KEY on Vercel, then redeploy production.",
      );
    }
    return copy(
      "rt_error_webrtc_sdp",
      "Voice could not connect to OpenAI (invalid session response). If you see quota or billing in the error, fix OpenAI billing and redeploy. Otherwise hard refresh and try again.",
    );
  }
  return msg;
}

function landingPhoneCtaLabel(phone: { display: string; tel: string }): string {
  const digits = (phone.tel || phone.display).replace(/\D/g, "");
  if (!digits) {
    return copy("rt_landing_cta_phone_pending", "Take the Challenge (number coming soon)");
  }
  return copy("rt_landing_cta", "Take the Challenge");
}

/** Minimal instructions for A/B vs BASE_INSTRUCTIONS (Platform playgroundâ€“style neutral assistant). */
const PLAYGROUND_PARITY_INSTRUCTIONS = `
You are a helpful assistant named Hannah. Reply concisely in plain spoken English â€” short sentences, natural flow. Answer directly without meta-commentary or lists unless asked.

Keep the **same calm speaking style on every turn** â€” one continuous voice on the call, not a different persona or energy level each reply.

When the voice session first goes live, **you speak first** â€” one clean flowing phrase with no mid-sentence period or comma after "Hey." Say "Hey it's Hannah with Hammer â€” what's on your mind?" or "Hannah here with Hammer â€” go ahead and ask me anything." Keep it to one breath. Do not split it into two separate sentences. Do not wait in silence for them to talk first.

If they open with pure small talk before any real question, reply with a single short warm clause bridged directly into an invite: "Doing great â€” what are you curious about?" No period mid-reply.

If they ask only for your name or what to call you, your entire reply must be exactly the word Hannah â€” nothing else.

Your first words are always the answer â€” except on the very first turn of the call, where your first words are that brief introduction as above.`;

const BASE_INSTRUCTIONS = HAMMER_SALES_INSTRUCTIONS;

const MODE_EXTRA: Record<AgentMode, string> = {
  general:
    "General mode: open with one discovery question about their current lead setup before making any claim. React to what they say; light discovery, no pitch until you know their platforms.",
  support:
    "Support mode: plain language, short reassurance, one concrete next step per turn. Never discuss pricing or trials.",
  leads:
    "Leads mode: BDC peer register. Lead with speed-to-lead pain â€” the window after a lead submits before competitors engage. Ask platform first, then pitch. State specifics only when confirmed.",
  receptionist:
    "Receptionist mode: quick, warm greeting. Find out who they are and what they need in one exchange, then route them.",
  survey:
    "Survey mode: one focused question per turn. Wait for a full answer before moving to the next question.",
  custom:
    "Custom mode: flexible, short, human turns. Adapt to whatever topic they raise.",
};

const heroNetworkSvg = `<svg class="hero-scene__network" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="landingMeshGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="rgba(43, 127, 212, 0.55)" />
      <stop offset="48%" stop-color="rgba(201, 30, 30, 0.5)" />
      <stop offset="100%" stop-color="rgba(43, 127, 212, 0.4)" />
    </linearGradient>
  </defs>
  <g fill="none" stroke="url(#landingMeshGrad)" stroke-width="1" stroke-linecap="round" opacity="0.55">
    <path d="M80 520 L280 380 L520 420 L720 260 L960 320 L1120 180" />
    <path d="M40 340 L240 460 L480 300 L660 360 L900 220 L1160 300" />
    <path d="M180 640 L400 520 L640 560 L820 420 L1040 480" />
    <path d="M280 380 L520 420" opacity="0.45" />
    <path d="M520 420 L720 260" opacity="0.45" />
    <path d="M720 260 L900 220" opacity="0.45" />
    <path d="M400 520 L520 420" opacity="0.35" />
    <path d="M820 420 L960 320" opacity="0.35" />
  </g>
  <g fill="url(#landingMeshGrad)" opacity="0.7">
    <circle cx="280" cy="380" r="3.5" /><circle cx="520" cy="420" r="3" />
    <circle cx="720" cy="260" r="4" /><circle cx="900" cy="220" r="3" />
    <circle cx="480" cy="300" r="2.5" /><circle cx="820" cy="420" r="3" />
  </g>
  <g fill="none" stroke="#AB0707" stroke-width="1.1" stroke-opacity="0.22" stroke-linecap="round">
    <path d="M600 760 L120 120"/><path d="M600 760 L300 80"/><path d="M600 760 L600 40"/>
    <path d="M600 760 L900 80"/><path d="M600 760 L1080 120"/>
  </g>
</svg>`;

const iconCallIdle = `<span class="btn-call-icon btn-call-icon--idle" aria-hidden="true">
  <svg class="btn-call-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2.25a2.75 2.75 0 0 0-2.75 2.75v7a2.75 2.75 0 0 0 5.5 0v-7A2.75 2.75 0 0 0 12 2.25z"/>
    <path d="M18.5 11.25v1.25a6.5 6.5 0 0 1-13 0v-1.25"/>
    <path d="M12 18.75v2.25"/><path d="M9 21h6"/>
  </svg>
</span>`;

const iconCallConnecting = `<span class="btn-call-icon btn-call-icon--connecting" aria-hidden="true">
  <svg class="btn-call-spinner" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.75" stroke-opacity="0.2"/>
    <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>
  </svg>
</span>`;

const iconGlassVoiceWave = `<span class="hero-glass__voice-wave" aria-hidden="true"><span class="hero-glass__voice-bar"></span><span class="hero-glass__voice-bar"></span><span class="hero-glass__voice-bar"></span><span class="hero-glass__voice-bar"></span><span class="hero-glass__voice-bar"></span></span>`;

/** Landing pill idle — three soft bars (not glass-toolbar EQ). */
const iconLandingCtaWave = `<span class="hero-glass__voice-wave landing-cta__wave" aria-hidden="true"><span class="hero-glass__voice-bar"></span><span class="hero-glass__voice-bar"></span><span class="hero-glass__voice-bar"></span></span>`;

/** Phone CTA — handset + gentle ripple (matches frosted pill, not DJ bars). */
const iconLandingCtaPhone = `<span class="landing-cta__phone-icon" aria-hidden="true">
  <span class="landing-cta__phone-ring landing-cta__phone-ring--a"></span>
  <span class="landing-cta__phone-ring landing-cta__phone-ring--b"></span>
  <svg class="landing-cta__phone-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">
    <path d="M5.25 4h4l2 5.5-2.25 1.35a12.5 12.5 0 0 0 5.15 5.15L15.5 15l5.5 2v4a2 2 0 0 1-2 2h-.75C8.4 23 1 15.6 1 6.25V5.5a2 2 0 0 1 2-2Z"/>
  </svg>
</span>`;

const iconProductColVoice = `<svg class="product-col__voice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M7 12a5 5 0 0 0 10 0"/><path d="M12 17v4"/></svg>`;
const iconProductColCheck = `<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.25 6.25 4.75 8.75 9.75 3.25"/></svg>`;

/** Handset glyph for the human sales line (header collapse + price/footer affordances). */
const iconSalesPhone = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5h3l1.4 4-2 1.3a12 12 0 0 0 5.6 5.6l1.3-2 4 1.4v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 5.7 2 2 0 0 1 6.5 3.5z"/></svg>`;

/** Microphone glyph centered inside the nav-panel footer voice signal orb. */
const iconNavFootMic = `<span class="nav-panel__foot-mic" aria-hidden="true"><svg class="nav-panel__foot-mic-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.25a2.75 2.75 0 0 0-2.75 2.75v7a2.75 2.75 0 0 0 5.5 0v-7A2.75 2.75 0 0 0 12 2.25z"/><path d="M7.5 12a4.5 4.5 0 0 0 9 0"/><path d="M12 18.75v2.25"/><path d="M9 21h6"/></svg></span>`;

/** Footer voice CTA — static mic glyph. */
const iconFooterCtaMic = `<svg class="footer-cta__mic-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M12 2.25a2.75 2.75 0 0 0-2.75 2.75v7a2.75 2.75 0 0 0 5.5 0v-7A2.75 2.75 0 0 0 12 2.25z"/>
  <path d="M7.5 12a4.5 4.5 0 0 0 9 0"/>
  <path d="M12 18.75v2.25"/>
  <path d="M9 21h6"/>
</svg>`;

/** Mini voice orb for live â€œEnd callâ€ pill â€” driven by voice-audio-visualizer.ts */
const iconGlassVoiceAuraMini = `<span class="landing-cta__voice-orb is-speaking" aria-hidden="true">
  <span class="landing-cta__voice-orb-aura" aria-hidden="true"></span>
  <span class="landing-cta__voice-orb-core" aria-hidden="true"></span>
</span>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeLeadWebsite(raw: string): string {
  const s = raw.trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s.replace(/^\/+/, "")}`;
}

function readLeadFormPayload(form: HTMLFormElement) {
  const raw = Object.fromEntries(new FormData(form)) as Record<string, string>;
  return {
    name: raw.name?.trim() ?? "",
    phone: raw.phone?.trim() ?? "",
    website: normalizeLeadWebsite(raw.website ?? ""),
    consent: Boolean(raw.consent),
  };
}

function validateLeadPayload(payload: ReturnType<typeof readLeadFormPayload>): string | null {
  if (!payload.name) return copy("rt_lead_err_name", "Name is required.");
  if (!payload.phone) return copy("rt_lead_err_phone", "Phone is required.");
  if (!payload.website.replace(/^https?:\/\//i, "").trim()) {
    return copy("rt_lead_err_website", "Dealership website is required.");
  }
  if (!payload.consent) {
    return copy("rt_lead_err_consent", "Please agree to be contacted to continue.");
  }
  return null;
}

function wireLeadRoleSelect(form: HTMLFormElement) {
  const wrap = form.querySelector<HTMLElement>("[data-lead-role]");
  const native = form.querySelector<HTMLSelectElement>(".lead-role-select__native");
  const trigger = form.querySelector<HTMLButtonElement>(".lead-role-select__trigger");
  const menu = form.querySelector<HTMLElement>(".lead-role-select__menu");
  const valueEl = form.querySelector<HTMLElement>(".lead-role-select__value");
  if (!wrap || !native || !trigger || !menu || !valueEl) return;

  const placeholder = copy("rt_lead_role_placeholder", "Select your role");
  const options = Array.from(menu.querySelectorAll<HTMLElement>("[role='option']"));

  const syncFromNative = () => {
    const selected = native.selectedOptions[0];
    const value = native.value;
    const label = value ? (selected?.textContent?.trim() ?? "") : placeholder;
    valueEl.textContent = label;
    valueEl.classList.toggle("is-placeholder", !value);
    options.forEach((opt) => {
      const isSelected = opt.dataset.value === value;
      opt.setAttribute("aria-selected", isSelected ? "true" : "false");
      opt.classList.toggle("is-selected", isSelected);
    });
  };

  const onDocumentPointer = (e: Event) => {
    if (!wrap.contains(e.target as Node)) closeMenu();
  };

  const closeMenu = () => {
    wrap.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    menu.hidden = true;
    document.removeEventListener("pointerdown", onDocumentPointer, true);
  };

  const openMenu = () => {
    wrap.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    menu.hidden = false;
    document.addEventListener("pointerdown", onDocumentPointer, true);
    const active = options.find((o) => o.dataset.value === native.value) ?? options[0];
    active?.focus();
  };

  const setValue = (value: string) => {
    native.value = value;
    native.dispatchEvent(new Event("change", { bubbles: true }));
    syncFromNative();
    closeMenu();
    trigger.focus();
  };

  syncFromNative();

  trigger.addEventListener("click", () => {
    if (wrap.classList.contains("is-open")) closeMenu();
    else openMenu();
  });

  options.forEach((opt) => {
    opt.addEventListener("click", () => setValue(opt.dataset.value ?? ""));
  });

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!wrap.classList.contains("is-open")) openMenu();
    }
    if (e.key === "Escape") closeMenu();
  });

  menu.addEventListener("keydown", (e) => {
    const idx = options.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu();
      trigger.focus();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      options[Math.min(idx + 1, options.length - 1)]?.focus();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      options[Math.max(idx - 1, 0)]?.focus();
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const active = document.activeElement as HTMLElement;
      if (options.includes(active)) setValue(active.dataset.value ?? "");
    }
  });

  form.addEventListener("reset", () => {
    window.requestAnimationFrame(syncFromNative);
    closeMenu();
  });
}

const HAMMER_FILL_API_TIMEOUT_MS = 55_000;
const HAMMER_CREATE_API_TIMEOUT_MS = 48_000;

const HAMMER_ACCOUNT_CREATED_VOICE_MSG =
  "account created — PHASE C.1 only: ask if Welcome to Hammer email arrived; do not mention activate, password, or card yet; do not call create_hammer_account";

async function hammerAccountStatusAfterSlowOp(email: string): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/hammer/account-status?email=${encodeURIComponent(email.trim())}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { account_created?: boolean };
    return data.account_created ? HAMMER_ACCOUNT_CREATED_VOICE_MSG : null;
  } catch {
    return null;
  }
}

async function hammerApiFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(
        `Request timed out after ${Math.round(timeoutMs / 1000)}s — call fill_hammer_account_field once more to confirm account_created; ` +
          "do not say a rep will reach out unless a second check still shows not created",
      );
    }
    throw e;
  }
}

async function readHttpErrorBody(res: Response): Promise<string> {
  const raw = (await res.text()).trim();
  if (!raw) {
    if (res.status === 500) {
      return (
        "Empty error body (HTTP 500). Often the Vite dev proxy could not reach the API " +
        "(start uvicorn on 127.0.0.1:8780 â€” see demo/realtime-sales-demo/run-demo.ps1) " +
        "or the connection was reset."
      );
    }
    return `HTTP ${res.status} (empty body)`;
  }
  try {
    const j = JSON.parse(raw) as { detail?: unknown };
    if (j.detail !== undefined) {
      return typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    }
  } catch {
    /* not JSON */
  }
  return raw.length > 2000 ? `${raw.slice(0, 2000)}â€¦` : raw;
}

let selectedMode: AgentMode = "general";

function initialVoiceScenario(): VoiceScenario {
  return "hammer";
}

let activeVoiceScenario: VoiceScenario = initialVoiceScenario();

/** After pen victory or confirmed challenge skip: wiki + capture_lead are active. */
let penHammerCloseActive = false;
/** True when they skipped the pen challenge (vs. won it and moved to Hammer close). */
let penChallengeSkipped = false;
let penBuyerProduct = "";
/** Product card the visitor clicked before starting browser voice (home page). */
let homeProductVoiceFocus = "";
let voiceUiRefresh: (() => void) | null = null;

let uiState: "idle" | "connecting" | "live" | "error" = "idle";
let statusText = "";
/** Set by mount() so the boot sequence can re-render once late-arriving site copy lands. */
let postBootRender: (() => void) | null = null;
let errorDetail = "";
let session: Conversation | null = null;
/** True while model TTS/audio output is generating (RealtimeSession audio_startâ†’audio_stopped). */
let assistantSpeaking = false;
/** Mic stream we pass into WebRTC so the same track can be metered for #footerPrimary waveform. */
let voiceCaptureStream: MediaStream | null = null;
/** One-time mic permission + stream warm-up on first user gesture (before call click). */
let voiceMicPrewarmStarted = false;
/** Real-time amplitude analyser wired to the WebRTC remote audio track (AI voice output). */
let orbAudioCtx: AudioContext | null = null;
let orbAnalyser: AnalyserNode | null = null;
let voiceVisualizer: VoiceVisualizerHandle | null = null;
let footerMicAudioCtx: AudioContext | null = null;
let footerMicSource: MediaStreamAudioSourceNode | null = null;
let footerMicAnalyser: AnalyserNode | null = null;
let footerMicLevelSmooth = 0;
/** Slide headline/sub aside only after the landing â€œlive demoâ€ pill (#footerPrimary) starts a session. */
let collapseHeroForLiveDemoCta = false;
/** Voice started from nav-panel footer — keep session in the modal, not the hero CTA layout. */
let voiceSessionAnchoredInNavPanel = false;
/** Voice started from home footer CTA — patch button in place instead of full render(). */
let voiceSessionAnchoredInFooter = false;
/** Bumped on endCall so an in-flight startCall cannot go live after the panel is dismissed. */
let voiceCallEpoch = 0;
type NavPanelId = "reviews" | "faq" | "terms" | "privacy" | "support" | "about";

function isLegalNavPanel(panel: NavPanelId | null): boolean {
  return panel === "terms" || panel === "privacy" || panel === "support" || panel === "about";
}

const NAV_PANEL_SECTION_IDS: Record<NavPanelId, string> = {
  reviews: "navPanelReviews",
  faq: "navPanelFaq",
  terms: "navPanelTerms",
  privacy: "navPanelPrivacy",
  support: "navPanelSupport",
  about: "navPanelAbout",
};

/** Every panel is addressable at its own path (e.g. hammertime.com/terms) for crawlers and compliance reviewers. */
const NAV_PANEL_PATHS: Record<NavPanelId, string> = {
  reviews: "/reviews",
  faq: "/faq",
  terms: "/terms",
  privacy: "/privacy",
  support: "/support",
  about: "/about",
};

function navPanelForPath(pathname: string): NavPanelId | null {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  for (const [panel, path] of Object.entries(NAV_PANEL_PATHS) as [NavPanelId, string][]) {
    if (normalized === path) return panel;
  }
  return null;
}

function initialOpenNavPanel(): NavPanelId | null {
  if (typeof window === "undefined") return null;
  const fromPath = navPanelForPath(window.location.pathname);
  if (fromPath) return fromPath;
  // Legacy deep links (?panel=terms) keep working.
  const panel = new URLSearchParams(window.location.search).get("panel");
  if (
    panel === "reviews" ||
    panel === "faq" ||
    panel === "terms" ||
    panel === "privacy" ||
    panel === "support" ||
    panel === "about"
  ) {
    return panel;
  }
  return null;
}

/**
 * Reflect the currently open nav panel in the URL via the `panel` query param,
 * without reloading or otherwise changing the view. Mirrors initialOpenNavPanel()
 * so a shared/refreshed URL reopens the same panel. No-op if the URL already matches.
 */
function syncNavPanelUrl(panel: NavPanelId | null): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  // Only manage the URL on the landing page and panel paths — never hijack e.g. /help.
  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  if (normalizedPath !== "/" && !navPanelForPath(normalizedPath)) return;
  url.searchParams.delete("panel");
  url.pathname = panel ? NAV_PANEL_PATHS[panel] : "/";
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  window.history.replaceState(window.history.state, "", next);
}

/** The "Get started" sign-up modal is addressable at its own path, like the nav panels. */
const LEAD_MODAL_PATH = "/get-started";

function initialLeadModalOpen(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === LEAD_MODAL_PATH) return true;
  // Legacy deep link (?modal=get-started) keeps working.
  return new URLSearchParams(window.location.search).get("modal") === "get-started";
}

/**
 * Reflect the "Get started" lead modal in the URL via the /get-started path so the
 * address bar shows a distinct, shareable link while the form is open. Reverts when
 * closed. Mirrors syncNavPanelUrl(): no reload, no view change, no-op if URL matches.
 */
function syncLeadModalUrl(open: boolean): void {
  if (typeof window === "undefined" || !window.history?.replaceState) return;
  const url = new URL(window.location.href);
  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  const managed =
    normalizedPath === "/" || normalizedPath === LEAD_MODAL_PATH || !!navPanelForPath(normalizedPath);
  if (!managed) return;
  url.searchParams.delete("modal");
  if (open) {
    url.pathname = LEAD_MODAL_PATH;
  } else if (normalizedPath === LEAD_MODAL_PATH) {
    url.pathname = openNavPanel ? NAV_PANEL_PATHS[openNavPanel] : "/";
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  window.history.replaceState(window.history.state, "", next);
}

let openNavPanel: NavPanelId | null = initialOpenNavPanel();
let mobileNavMenuOpen = false;
let leadModalOpen = initialLeadModalOpen();
let callMeModalOpen = false;
/** Product name from the card Sign Up button that last opened the lead modal (e.g. "Hammer Drive"). */
let leadModalSourceProduct = "";
/** Tracks the lead modal contact-consent checkbox so its state survives overlay re-renders. */
let leadConsentChecked = false;

const CHROME_NAV_SECTIONS: { id: NavPanelId; key: string; fallback: string; controls: string }[] = [];

function renderChromeNavJumpButtons(extraClass = ""): string {
  return CHROME_NAV_SECTIONS.map(({ id, key, fallback, controls }) => {
    const active = openNavPanel === id;
    const cls = `chrome__jump chrome__jump--panel${extraClass ? ` ${extraClass}` : ""}${active ? " is-active" : ""}`;
    return `<a href="${NAV_PANEL_PATHS[id]}" class="${cls}" data-panel="${id}"
              aria-expanded="${active}" aria-controls="${controls}">
              ${escapeHtml(copy(key, fallback))}
            </a>`;
  }).join("\n");
}

function renderFooterReviewsButton(): string {
  const active = openNavPanel === "reviews";
  return `<a href="/reviews" class="chrome__jump chrome__jump--panel${active ? " is-active" : ""}" data-panel="reviews" aria-expanded="${active}" aria-controls="navPanelReviews" id="footerOpenReviews">${escapeHtml(copy("rt_nav_reviews", "Reviews"))}</a>`;
}

function renderChromeSignUpButton(opts?: { id?: string; extraClass?: string; dataAction?: string }): string {
  const extraClass = opts?.extraClass ?? "";
  const active = leadModalOpen ? " is-active" : "";
  const cls = `chrome__jump chrome__jump--panel${extraClass ? ` ${extraClass}` : ""}${active}`;
  const idAttr = opts?.id ? ` id="${opts.id}"` : "";
  const actionAttr = opts?.dataAction ? ` data-action="${opts.dataAction}"` : "";
  return `<button type="button" class="${cls}"${idAttr}${actionAttr} aria-label="${escapeHtml(copy("rt_nav_sign_up_aria", "Sign up for Hammer"))}">
              ${escapeHtml(copy("rt_nav_cta", "Get Started"))}            </button>`;
}

function renderChromeLoginLink(extraClass = ""): string {
  const cls = `chrome__jump chrome__jump--login${extraClass ? ` ${extraClass}` : ""}`;
  return `<a class="${cls}" href="${escapeHtml(SIGN_IN_URL)}" target="_blank" rel="noopener noreferrer">${escapeHtml(copy("rt_site_footer_login", "Login"))}</a>`;
}

/** Header click-to-call to a human rep, with the support line stacked below. Collapses to a tap-to-call handset glyph on phones. */
function renderChromeSalesPhone(): string {
  const phone = salesPhone();
  const prefix = copy("rt_sales_phone_prefix", "Sales");
  const aria = copy("rt_sales_phone_aria", "Call Hammer sales at {phone}").replace("{phone}", phone.display);
  const supportPrefix = copy("rt_support_phone_prefix", "Support");
  const supportDisplay = copy("rt_support_phone_display", "(512) 883-1336");
  const supportHref = `tel:+1${copy("rt_support_phone_tel", "5128831336")}`;
  const supportAria = copy("rt_support_phone_aria", "Call Hammer support at {phone}").replace("{phone}", supportDisplay);
  return `<div class="chrome__phones">
            <a class="chrome__jump chrome__sales" href="${escapeHtml(phone.href)}" data-sales-call="header" aria-label="${escapeHtml(aria)}">
              <span class="chrome__sales__icon" aria-hidden="true">${iconSalesPhone}</span>
              <span class="chrome__sales__prefix">${escapeHtml(prefix)}</span>
              <span class="chrome__sales__num">${escapeHtml(phone.display)}</span>
            </a>
            <a class="chrome__jump chrome__sales chrome__sales--support" href="${escapeHtml(supportHref)}" aria-label="${escapeHtml(supportAria)}">
              <span class="chrome__sales__prefix">${escapeHtml(supportPrefix)}</span>
              <span class="chrome__sales__num">${escapeHtml(supportDisplay)}</span>
            </a>
          </div>`;
}

function navPanelTitle(panel: NavPanelId): string {
  const keys: Record<NavPanelId, [string, string]> = {
    reviews: ["rt_nav_reviews", "Reviews"],
    faq: ["rt_nav_faq", "FAQ"],
    terms: ["rt_site_footer_terms", "Terms of Service"],
    privacy: ["rt_site_footer_privacy", "Privacy Policy"],
    support: ["rt_site_footer_support", "Contact Support"],
    about: ["rt_footer_about_h", "About Us"],
  };
  const [key, fallback] = keys[panel];
  return copy(key, fallback);
}

function navPanelAriaLabel(panel: NavPanelId | null): string {
  if (panel === "terms" || panel === "privacy") {
    return copy("rt_footer_legal_panel_aria", "Legal information");
  }
  if (panel === "support") {
    return copy("rt_site_footer_support_aria", "Contact support");
  }
  return copy("rt_nav_panel_aria", "Navigation panel");
}

type SiteCopy = Record<string, string>;
let siteCopy: SiteCopy = {};

function withoutEmDash(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ", ")
    .replace(/\u2014/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s+\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Every copy() call is recorded so the post-fetch boot step can tell whether the
 * server copy would actually change anything on screen. If not, the second full
 * re-render is skipped — that rebuild was resetting LCP several seconds late.
 */
const renderedCopyLog = new Map<string, string>();

function copy(key: string, fallback: string): string {
  const v = siteCopy[key]?.trim();
  const out = withoutEmDash(v || fallback);
  renderedCopyLog.set(`${key}\u0000${fallback}`, out);
  return out;
}

/**
 * copy() without staleness logging — for the demo-phone keys consumed by
 * demoPhoneInfo()/callMeModalHint(). Those resolve through env fallbacks, so
 * raw values routinely go from "" to the same number the env already provided;
 * real phone changes are caught by the boot phone-config snapshot instead.
 */
function copyUntracked(key: string, fallback: string): string {
  const v = siteCopy[key]?.trim();
  return withoutEmDash(v || fallback);
}

/** True if any previously rendered copy string would render differently now. */
function renderedCopyIsStale(): boolean {
  return staleCopyKeys().length > 0;
}

function staleCopyKeys(): string[] {
  const stale: string[] = [];
  for (const [logKey, prev] of renderedCopyLog) {
    const sep = logKey.indexOf("\u0000");
    const key = logKey.slice(0, sep);
    const fallback = logKey.slice(sep + 1);
    const v = siteCopy[key]?.trim();
    if (withoutEmDash(v || fallback) !== prev) stale.push(key);
  }
  return stale;
}

/** Wrap a phrase in a hero emphasis span (escaped). */
function heroTitleEmphasis(raw: string, className: string): string {
  return `<span class="${className}">${escapeHtml(heroTitleHotDisplay(raw))}</span>`;
}

/** Pen / Car always render with leading cap in the red accent. */
function heroTitleHotDisplay(word: string): string {
  if (/^pen$/i.test(word)) return "Pen";
  if (/^car$/i.test(word)) return "Car";
  return word;
}

/** Highlight regex capture groups inside copy (pen challenge + dealership payoff). */
function heroTitleWithMarks(
  raw: string,
  marks: { pattern: RegExp; className: string }[],
): string {
  type Segment = { start: number; end: number; className: string; text: string };
  const segments: Segment[] = [];
  for (const { pattern, className } of marks) {
    const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const text = m[1] ?? m[0];
      segments.push({ start: m.index, end: m.index + text.length, className, text });
    }
  }
  segments.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Segment[] = [];
  for (const seg of segments) {
    if (kept.some((k) => seg.start < k.end && seg.end > k.start)) continue;
    kept.push(seg);
  }
  kept.sort((a, b) => a.start - b.start);
  let html = "";
  let cursor = 0;
  for (const seg of kept) {
    html += escapeHtml(raw.slice(cursor, seg.start));
    html += heroTitleEmphasis(seg.text, seg.className);
    cursor = seg.end;
  }
  html += escapeHtml(raw.slice(cursor));
  return html;
}

const HERO_TITLE_HOT = "landing-hero__title-hot";
const NBSP = "\u00a0";

/** Non-breaking gaps so common phrases stay together when the line wraps (mobile). */
function heroTitlePhraseLocks(raw: string): string {
  return raw
    .replace(/\ba\s+pen\b/gi, `a${NBSP}Pen`)
    .replace(/\ba\s+car\b/gi, `a${NBSP}Car`)
    .replace(/\b(Your)\s+(Customers)\b/gi, `$1${NBSP}$2`)
    .replace(/\b(Sell)\s+(Your)\b/gi, `$1${NBSP}$2`);
}

/** One centered text box per headline row; only Pen/Car get an inline accent span. */
function heroTitleRowHtml(
  key: string,
  fallback: string,
  row: "lead" | "payoff",
  highlight: RegExp,
): string {
  const raw = heroTitlePhraseLocks(copy(key, fallback).trim());
  const agentic = raw.match(/agentic\s+ai/i);
  const marks = agentic
    ? [{ pattern: /agentic\s+ai/i, className: HERO_TITLE_HOT }]
    : [{ pattern: highlight, className: HERO_TITLE_HOT }];
  const inner = heroTitleWithMarks(raw, marks);
  return `<span class="landing-hero__title-row landing-hero__title-row--${row}">${inner}</span>`;
}

function heroTitlePrimaryHtml(key: string, fallback: string): string {
  return heroTitleRowHtml(key, fallback, "lead", /\b(pen)\b/i);
}

function heroTitleAccentHtml(key: string, fallback: string): string {
  return heroTitleRowHtml(key, fallback, "payoff", /\b(car)\b/i);
}

function renderHeroTitleHtml(): string {
  const lead = copy("rt_hero_title_primary", "If Hammer Can Sell You a Pen,");
  const payoff = copy("rt_hero_title_accent", "It Can Sell Your Customers a Car");
  const ariaLabel = `${lead.replace(/,\s*$/, "")}, ${payoff}`.replace(/\s+/g, " ").trim();
  return `<h1 class="landing-hero__title" aria-label="${escapeHtml(ariaLabel)}">
              <span class="landing-hero__title-eyebrow">${escapeHtml(copy("rt_hero_eyebrow", "Hammer Pen Challenge"))}</span>
              <span class="landing-hero__headline">
                ${heroTitlePrimaryHtml("rt_hero_title_primary", lead)}
                ${heroTitleAccentHtml("rt_hero_title_accent", payoff)}
              </span>
            </h1>`;
}

function renderProductColBullet(key: string, fallback: string): string {
  return `<li class="product-col__bullet">
              <span class="product-col__bullet-mark" aria-hidden="true">${iconProductColCheck}</span>
              <span class="product-col__bullet-text">${escapeHtml(copy(key, fallback))}</span>
            </li>`;
}

function renderProductColPrice(key: string, fallback: string, productName: string): string {
  const text = copy(key, fallback).trim();
  const ariaLabel = copy("rt_product_price_sign_up_aria", "Sign up for {product} — {price}")
    .replace("{product}", productName)
    .replace("{price}", text);
  const actionAttrs = `type="button" class="product-col__price" data-action="open-sign-up" data-product="${escapeHtml(productName)}" aria-label="${escapeHtml(ariaLabel)}"`;

  const prefixMatch = text.match(/^From\s+(.+)$/i);
  const prefix = prefixMatch ? "From" : "";
  const rest = prefixMatch ? prefixMatch[1].trim() : text;

  // Split a real dollar figure ("$299/mo") from any trailing qualifier ("+ ad spend")
  // so the amount stays the anchor and the qualifier reads as a quiet note.
  const amountMatch = rest.match(/^(\$[\d,]+(?:\.\d+)?(?:\s*\/\s*mo)?)\s*(.*)$/i);
  if (amountMatch) {
    const amount = amountMatch[1].replace(/\s*\/\s*mo/i, "/mo");
    const note = amountMatch[2].trim();
    return `<button ${actionAttrs}>
              ${prefix ? `<span class="product-col__price-prefix">${escapeHtml(prefix)}</span>` : ""}
              <span class="product-col__price-amount">${escapeHtml(amount)}</span>
              ${note ? `<span class="product-col__price-note">${escapeHtml(note)}</span>` : ""}
            </button>`;
  }

  // Non-numeric pricing ("Varies by lot size") reads as a label, not a heavy figure.
  return `<button ${actionAttrs}><span class="product-col__price-label">${escapeHtml(text)}</span></button>`;
}

type ProductColSpec = {
  slug: string;
  modifier: "drive" | "aia" | "marketposter";
  nameKey: string;
  nameFallback: string;
  taglineKey: string;
  taglineFallback: string;
  priceKey?: string;
  priceFallback?: string;
  bullets: { key: string; fallback: string }[];
  voiceAriaKey: string;
  voiceAriaFallback: string;
  /** Featured product gets center placement, a badge, and the primary CTA treatment. */
  featured?: boolean;
  badgeKey?: string;
  badgeFallback?: string;
};

const PRODUCT_COL_SPECS: ProductColSpec[] = [
  {
    slug: "Facebook AIA",
    modifier: "aia",
    nameKey: "rt_product_aia_name",
    nameFallback: "Facebook Ads",
    taglineKey: "rt_product_aia_tagline",
    taglineFallback: "Runs Facebook and Instagram ads from your lot.",
    priceKey: "rt_product_aia_price",
    priceFallback: "$299/mo + ad spend",
    bullets: [
      { key: "rt_product_aia_b1", fallback: "Your cars are the ads." },
      { key: "rt_product_aia_b2", fallback: "Hammer answers every lead." },
      { key: "rt_product_aia_b3", fallback: "Shows on Facebook and Instagram together." },
    ],
    voiceAriaKey: "rt_product_voice_aria_aia",
    voiceAriaFallback: "Ask Hannah to pitch you on Facebook AIA",
  },
  {
    slug: "Hammer Drive",
    modifier: "drive",
    nameKey: "rt_product_drive_name",
    nameFallback: "Hammer Drive",
    taglineKey: "rt_product_drive_tagline",
    taglineFallback: "Instantly answers leads from every source, then follows up until they book.",
    priceKey: "rt_product_drive_price",
    priceFallback: "Varies by lot size",
    bullets: [
      { key: "rt_product_drive_b1", fallback: "Replies in seconds, day or night." },
      { key: "rt_product_drive_b2", fallback: "Follows up for weeks when buyers go quiet." },
      { key: "rt_product_drive_b3", fallback: "Books the appointment right in your CRM." },
    ],
    voiceAriaKey: "rt_product_voice_aria_drive",
    voiceAriaFallback: "Ask Hannah to pitch you on Hammer Drive",
    featured: true,
    badgeKey: "rt_product_drive_badge",
    badgeFallback: "Most Popular",
  },
  {
    slug: "MarketPoster",
    modifier: "marketposter",
    nameKey: "rt_product_mp_name",
    nameFallback: "MarketPoster",
    taglineKey: "rt_product_mp_tagline",
    taglineFallback: "Post your whole lot to Facebook Marketplace in one click.",
    priceKey: "rt_product_mp_price",
    priceFallback: "From $99/mo",
    bullets: [
      { key: "rt_product_mp_b1", fallback: "Never retype price, photos, or VIN." },
      { key: "rt_product_mp_b2", fallback: "Select cars and post in bulk." },
      { key: "rt_product_mp_b3", fallback: "Auto-reposts so your listings stay on top." },
    ],
    voiceAriaKey: "rt_product_voice_aria_mp",
    voiceAriaFallback: "Ask Hannah to pitch you on MarketPoster",
  },
];

function renderProductColCard(spec: ProductColSpec, live: boolean, connecting: boolean): string {
  const name = copy(spec.nameKey, spec.nameFallback);
  const featuredClass = spec.featured ? " product-col--featured" : "";
  const badge =
    spec.featured && spec.badgeKey && spec.badgeFallback
      ? `<span class="product-col__badge">${escapeHtml(copy(spec.badgeKey, spec.badgeFallback))}</span>`
      : "";
  return `<article class="product-col product-col--${spec.modifier}${featuredClass}${productColVoiceSessionClass(spec.slug, live, connecting)}" data-voice-product="${escapeHtml(spec.slug)}">
              <div class="product-col__atmosphere" aria-hidden="true"></div>
              <div class="product-col__surface">
                <div class="product-col__badge-row">${badge}</div>
                <header class="product-col__head">
                  <h2 class="product-col__name">${escapeHtml(name)}</h2>
                  <p class="product-col__tagline">${escapeHtml(copy(spec.taglineKey, spec.taglineFallback))}</p>
                </header>
                <div class="product-col__feats-panel">
                  <ul class="product-col__feats">
                    ${spec.bullets.map((b) => renderProductColBullet(b.key, b.fallback)).join("")}
                  </ul>
                </div>
                <footer class="product-col__foot">
                  ${spec.priceKey && spec.priceFallback ? renderProductColPrice(spec.priceKey, spec.priceFallback, name) : ""}
                  <button type="button" class="product-col__signup" data-action="open-sign-up"
                    data-product="${escapeHtml(name)}"
                    aria-label="${escapeHtml(copy("rt_nav_sign_up_aria", "Sign up for Hammer"))}">
                    ${escapeHtml(copy("rt_nav_cta", "Get Started"))}
                  </button>
                </footer>
              </div>
            </article>`;
}

function productColVoiceSessionClass(productName: string, live: boolean, connecting: boolean): string {
  const isActive = homeProductVoiceFocus === productName && (live || connecting);
  return isActive ? " is-voice-session" : "";
}

function renderProductColumnsHtml(live = false, connecting = false): string {
  const aria = copy("rt_product_cols_aria", "Hammer products");
  return `<div class="product-columns" aria-label="${escapeHtml(aria)}">
            ${PRODUCT_COL_SPECS.map((spec) => renderProductColCard(spec, live, connecting)).join("")}
          </div>`;
}

function renderPenChallengeCtaHtml(live: boolean, connecting: boolean): string {
  const ctaLabel = copy("rt_landing_cta", "Take the Challenge");
  if (outboundCallMePrimary()) {
    return renderPhonePrimaryPillHtml(demoPhoneInfo());
  }
  if (BROWSER_VOICE_ENABLED) {
    return `<button type="button" class="hero-glass__voice landing-cta${live ? " is-live voice-live-end" : ""}${live && !REDUCE_MOTION ? " mic-reactive" : ""}${connecting ? " is-connecting" : ""}" id="footerPrimary" data-voice-scenario="hammer"${connecting ? " disabled" : ""}
              aria-label="${connecting ? escapeHtml(copy("rt_call_aria_connecting", "Connecting")) : live ? escapeHtml(copy("rt_call_aria_end", "End call")) : escapeHtml(ctaLabel)}">
              <span class="landing-cta__wave-slot" aria-hidden="true">${live ? iconGlassVoiceAuraMini : iconLandingCtaWave}</span>
              <span class="landing-cta__label">${live ? escapeHtml(copy("rt_call_aria_end", "End call")) : escapeHtml(ctaLabel)}</span>
            </button>`;
  }
  const phone = demoPhoneInfo();
  if (phone.href || phone.display || phone.tel) {
    return renderPhonePrimaryPillHtml(phone);
  }
  const pendingLabel = landingPhoneCtaLabel(phone);
  return `<button type="button" class="hero-glass__voice landing-cta landing-cta--phone" id="footerPrimary" disabled
              aria-label="${escapeHtml(pendingLabel)}">
              <span class="landing-cta__wave-slot landing-cta__wave-slot--phone" aria-hidden="true">${iconLandingCtaPhone}</span>
              <span class="landing-cta__label">${escapeHtml(pendingLabel)}</span>
            </button>`;
}

function renderHeroVoiceCardHtml(live: boolean, connecting: boolean): string {
  return `<div class="hero-voice-card hero-glass__panel${live ? " is-open is-live-session" : ""}" id="glassVoice">
                <div class="hero-glass__panel-inner">
                  <div class="hero-glass__live voice-body voice-body--resolution">
                    ${renderHeroVoiceHintHtml(live, "hammer")}
                    <div class="call-row voice-stage${live ? " voice-stage--live" : ""}">
                      ${live
                          ? `<div class="voice-live-stack">
                            <div class="voice-live-orb-wrap">
                              <div class="voice-liquid-orb" aria-hidden="true">
                              <div class="voice-liquid-orb__clip">
                                <div class="call-hero-zone voice-stage__glow" aria-hidden="true"></div>
                                <div class="voice-stage__mesh" aria-hidden="true"></div>
                                <div class="voice-audio-visualizer voice-stage__visualizer is-active" aria-hidden="true">
                                  <span class="voice-audio-visualizer__aura voice-audio-visualizer__aura_speaking">
                                    <span class="voice-audio-visualizer__ink" aria-hidden="true"></span>
                                    <span class="voice-audio-visualizer__grain" aria-hidden="true"></span>
                                    <span class="voice-audio-visualizer__core" aria-hidden="true"></span>
                                  </span>
                                </div>
                                <span class="voice-stage__ambient-listen" aria-hidden="true"></span>
                              </div>
                              <span class="voice-liquid-orb__frost" aria-hidden="true"></span>
                              <span class="voice-liquid-orb__glass" aria-hidden="true"></span>
                              <span class="voice-liquid-orb__shade" aria-hidden="true"></span>
                              <span class="voice-liquid-orb__noise" aria-hidden="true"></span>
                              <span class="voice-liquid-orb__rim" aria-hidden="true"></span>
                              </div>
                            </div>
                            <div class="voice-live-meta btn-call-orb-caption btn-call-orb-caption--stage">
                              <span class="btn-call-orb-caption__title">${escapeHtml(copy("rt_voice_orb_title", "Hannah"))}</span>
                              <span class="voice-live-meta__role">${escapeHtml(copy("rt_voice_orb_subtitle", "Hammer AI sales rep"))}</span>
                              <span class="voice-live-status" role="status" aria-label="${escapeHtml(copy("rt_listen_label", "Live"))}">
                                <span class="voice-live-status__dot" aria-hidden="true"></span>
                                <span class="voice-live-status__label">${escapeHtml(copy("rt_listen_label", "Live"))}</span>
                              </span>
                            </div>
                          </div>`
                          : `<div class="call-hero-zone voice-stage__glow" aria-hidden="true"></div>
                            <div class="voice-stage__mesh" aria-hidden="true"></div>`}
                      <div class="call-stack${live ? " call-stack--live" : ""}${live && assistantSpeaking ? " is-assistant-speaking" : ""}">
                        ${renderBrowserCallOrbHtml(live, connecting)}
                        ${renderBrowserCallPromptHtml(live, connecting, uiState === "error", errorDetail)}
                        ${!live
                          ? `<div class="listen-indicator" aria-hidden="true">
                          ${(() => {
                            const sub = copy("rt_listen_sub", "").trim();
                            return sub
                              ? `<p class="listen-indicator-sub">${escapeHtml(sub)}</p>`
                              : "";
                          })()}
                        </div>`
                          : ""}
                      </div>
                    </div>
                  </div>
                </div>
              </div>`;
}

function renderPenChallengePanelHtml(live: boolean, connecting: boolean, callFocus: boolean): string {
  return `<div class="pen-challenge-panel">
              <section class="landing-hero pen-challenge-panel__hero${callFocus ? " is-call-focus" : ""}" aria-label="${escapeHtml(copy("rt_pen_challenge_section_aria", "Hammer Pen Challenge live demo"))}">
                ${renderHeroVoiceCardHtml(live, connecting)}
                ${renderHeroTitleHtml()}
                <div class="landing-hero__interaction">
                  <div class="landing-hero__support hero-sub-wrap">
                    <p class="landing-hero__sub">${escapeHtml(
                      copy(
                        "rt_hero_sub_pills",
                        "You're the buyer. Push back. See if our AI can close the sale.",
                      ),
                    )}</p>
                    <div class="landing-hero__cta-wrap">
                      ${renderPenChallengeCtaHtml(live, connecting)}
                    </div>
                  </div>
                </div>
              </section>
            </div>`;
}

function renderHomeHeroHtml(): string {
  const accentRaw = copy("rt_home_title_accent", "Human-like Agentic AI").trim();
  const accentHtml = heroTitleWithMarks(accentRaw, [
    { pattern: /agentic\s+ai/i, className: "landing-home__title-hot" },
  ]);
  const payoff = copy("rt_home_title_payoff", "for dealerships");
  const ariaLabel = `${accentRaw}, ${payoff}`.replace(/\s+/g, " ").trim();
  return `<header class="landing-home__intro">
              <h1 class="landing-home__title" aria-label="${escapeHtml(ariaLabel)}">
                <span class="landing-home__headline">
                  <span class="landing-home__title-line landing-home__title-line--lead">${accentHtml}</span>
                  <span class="landing-home__title-line landing-home__title-line--payoff">${escapeHtml(payoff)}</span>
                </span>
              </h1>
            </header>
            <div class="landing-home__rule" aria-hidden="true"><span></span></div>`;
}

function renderFooterCtaHtml(live: boolean, connecting: boolean): string {
  const ctaLabel = copy("rt_home_voice_cta", "Talk to Hannah, our voice AI");
  if (NAV_PANEL_VOICE_ENABLED) {
    return `<button type="button"
              id="footerCtaVoice"
              class="footer-cta__pill footer-cta__pill--voice${live ? " is-live" : ""}${connecting ? " is-connecting" : ""}"
              data-voice-scenario="hammer"
              ${connecting ? "disabled" : ""}
              aria-label="${connecting ? escapeHtml(copy("rt_call_aria_connecting", "Connecting…")) : live ? escapeHtml(copy("rt_call_aria_end", "End call")) : escapeHtml(ctaLabel)}">
              <span class="footer-cta__pill-wave" aria-hidden="true">${iconFooterCtaMic}</span>
              <span class="footer-cta__pill-label">${live ? escapeHtml(copy("rt_call_aria_end", "End call")) : escapeHtml(ctaLabel)}</span>
            </button>`;
  }
  if (outboundCallMePrimary()) {
    return `<button type="button" class="footer-cta__pill footer-cta__pill--phone" id="footerCtaVoice"
              aria-label="${escapeHtml(copy("rt_call_aria_phone", "Call Hannah on your phone"))}" aria-haspopup="dialog">
              <span class="footer-cta__pill-wave footer-cta__pill-wave--phone" aria-hidden="true">${iconLandingCtaPhone}</span>
              <span class="footer-cta__pill-label">${escapeHtml(copy("rt_home_voice_cta", "Talk to Hannah, our voice AI"))}</span>
            </button>`;
  }
  return `<button type="button" class="footer-cta__pill" data-action="open-sign-up" aria-label="${escapeHtml(copy("rt_nav_sign_up_aria", "Sign up for Hammer"))}">
            <span class="footer-cta__pill-label">${escapeHtml(copy("rt_nav_cta", "Get Started"))}</span>
            <span class="footer-cta__pill-arrow" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h9M8.5 3.5 13 8l-4.5 4.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </span>
          </button>`;
}

/** Secondary tel: link — hidden when browser voice is the primary CTA (single pill layout). */
function renderSecondaryPhoneCtaHtml(_live: boolean, _connecting: boolean): string {
  return "";
}

function renderPhonePrimaryPillHtml(phone: { display: string; tel: string; href: string }): string {
  const phoneLabel = landingPhoneCtaLabel(phone);
  const phoneAria = copy("rt_call_aria_phone", "Call Hannah on your phone");
  const inner = `<span class="landing-cta__wave-slot landing-cta__wave-slot--phone" aria-hidden="true">${iconLandingCtaPhone}</span>
              <span class="landing-cta__label">${escapeHtml(phoneLabel)}</span>`;
  if (outboundCallMePrimary()) {
    return `<button type="button" class="hero-glass__voice landing-cta landing-cta--phone" id="footerPrimary"
              aria-label="${escapeHtml(phoneAria)}"
              aria-haspopup="dialog">
              ${inner}
            </button>`;
  }
  if (phone.href) {
    return `<a class="hero-glass__voice landing-cta landing-cta--phone" id="footerPrimary" href="${escapeHtml(phone.href)}"
              aria-label="${escapeHtml(phoneAria)}">
              ${inner}
            </a>`;
  }
  return `<button type="button" class="hero-glass__voice landing-cta landing-cta--phone" id="footerPrimary" disabled
              aria-label="${escapeHtml(phoneLabel)}">
              ${inner}
            </button>`;
}

/** Hannah voice demo retired — the outbound "call me" modal no longer ships. */
function renderCallMeModalHtml(): string {
  return "";
}

function renderPrimaryCtaHtml(live: boolean, connecting: boolean): string {
  const phone = demoPhoneInfo();
  const ctaLabel = activeVoiceScenario === "hammer"
    ? copy("rt_landing_cta_hammer", "Talk to Hannah")
    : copy("rt_landing_cta", "Take the Challenge");
  if (outboundCallMePrimary()) {
    return renderPhonePrimaryPillHtml(phone);
  }
  if (BROWSER_VOICE_ENABLED) {
    return `<button type="button" class="hero-glass__voice landing-cta${live ? " is-live voice-live-end" : ""}${live && !REDUCE_MOTION ? " mic-reactive" : ""}${connecting ? " is-connecting" : ""}" id="footerPrimary" data-voice-scenario="hammer"${connecting ? " disabled" : ""}
              aria-label="${connecting ? escapeHtml(copy("rt_call_aria_connecting", "Connecting")) : live ? escapeHtml(copy("rt_call_aria_end", "End call")) : escapeHtml(ctaLabel)}">
              <span class="landing-cta__wave-slot" aria-hidden="true">${live ? iconGlassVoiceAuraMini : iconLandingCtaWave}</span>
              <span class="landing-cta__label">${live ? escapeHtml(copy("rt_call_aria_end", "End call")) : escapeHtml(ctaLabel)}</span>
            </button>`;
  }
  if (outboundCallMePrimary() || phone.href || phone.display || phone.tel) {
    return renderPhonePrimaryPillHtml(phone);
  }
  const pendingLabel = landingPhoneCtaLabel(phone);
  return `<button type="button" class="hero-glass__voice landing-cta landing-cta--phone" id="footerPrimary" disabled
              aria-label="${escapeHtml(pendingLabel)}">
              <span class="landing-cta__wave-slot landing-cta__wave-slot--phone" aria-hidden="true">${iconLandingCtaPhone}</span>
              <span class="landing-cta__label">${escapeHtml(pendingLabel)}</span>
            </button>`;
}

function renderHeroVoiceHintHtml(live: boolean, scenario: VoiceScenario = activeVoiceScenario): string {
  if (live) return "";
  if (!BROWSER_VOICE_ENABLED) {
    const phone = demoPhoneInfo();
    const hint = phone.display
      ? copy(
          "rt_phone_hint",
          "Call Hannah on your phone. You're the buyer in the Sell Me a Pen challenge. Push back anytime.",
        )
      : copy("rt_phone_hint_pending", "A demo phone number will be added here soon.");
    return `<p class="voice-hint voice-hint--phone">${escapeHtml(hint)}</p>`;
  }
  return `<p class="voice-hint">${escapeHtml(
    copy(
      "rt_voice_hint",
      "Tap the mic and ask about leads, follow-up, Facebook AIA, or integrations.",
    ),
  )}</p>`;
}

function renderBrowserCallOrbHtml(live: boolean, connecting: boolean): string {
  if (!BROWSER_VOICE_ENABLED || live) return "";
  return `<div class="btn-call-shell${connecting ? " is-connecting" : ""}">
                          <span class="btn-call-orbit btn-call-orbit--a" aria-hidden="true"></span>
                          <span class="btn-call-orbit btn-call-orbit--b" aria-hidden="true"></span>
                          <span class="btn-call-orbit btn-call-orbit--c" aria-hidden="true"></span>
                          <button type="button" class="btn-call${connecting ? " is-connecting" : ""}" id="callBtnInner" data-voice-scenario="hammer"${connecting ? " disabled" : ""}
                            aria-label="${connecting ? escapeHtml(copy("rt_call_aria_connecting", "Connecting")) : escapeHtml(copy("rt_call_aria_start", "Start voice call"))}">
                            <span class="btn-call-core">
                              <span class="btn-call-core__shine" aria-hidden="true"></span>
                              <span class="btn-call-core__inner">
                                ${connecting ? iconCallConnecting : iconCallIdle}
                              </span>
                            </span>
                          </button>
                        </div>`;
}

function renderBrowserCallPromptHtml(live: boolean, connecting: boolean, hasError = false, errorMsg = ""): string {
  if (!BROWSER_VOICE_ENABLED || live) return "";
  const mainText = connecting
    ? escapeHtml(copy("rt_call_prompt_connecting", "Connecting"))
    : hasError
      ? escapeHtml(copy("rt_call_prompt_error", "Connection failed. Tap to retry"))
      : escapeHtml(copy("rt_call_prompt_tap", "Tap to talk"));
  const subText = connecting
    ? escapeHtml(copy("rt_call_prompt_connecting_sub", "Securing your voice session"))
    : hasError && errorMsg
      ? escapeHtml(errorMsg.slice(0, 120))
      : escapeHtml(copy("rt_call_prompt_mic_sub", "Allow microphone when prompted"));
  return `<p class="call-prompt${connecting ? " is-connecting" : hasError ? " is-error" : ""}" aria-live="polite">
                          <span class="call-prompt__main">${mainText}</span>
                          <span class="call-prompt__sub">${subText}</span>
                        </p>`;
}

/** Live voice demo retired — the nav panel no longer has a demo foot card. */
function renderNavPanelFootHtml(): string {
  return "";
}

async function loadDemoPhoneFromHealth(): Promise<void> {
  try {
    const res = await fetch("/api/telephony/status", {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        display?: string | null;
        dial_e164?: string | null;
        outbound_enabled?: boolean;
        outbound_api_url?: string | null;
      };
      const display = (data.display || "").trim();
      const number = (data.dial_e164 || "").trim();
      if (display) healthDemoPhone.display = display;
      if (number) healthDemoPhone.tel = number.replace(/\D/g, "");
      telephonyOutbound.enabled = Boolean(data.outbound_enabled);
      telephonyOutbound.apiUrl = (data.outbound_api_url || "").trim();
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    const res = await fetch("/api/health", { cache: "no-store", signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return;
    const data = (await res.json()) as {
      demo_phone_display?: string | null;
      demo_phone_number?: string | null;
      outbound_enabled?: boolean;
      outbound_api_url?: string | null;
    };
    const display = (data.demo_phone_display || "").trim();
    const number = (data.demo_phone_number || "").trim();
    if (display) healthDemoPhone.display = display;
    if (number) healthDemoPhone.tel = number.replace(/\D/g, "");
    if (data.outbound_enabled !== undefined) {
      telephonyOutbound.enabled = Boolean(data.outbound_enabled);
    }
    if (data.outbound_api_url) {
      telephonyOutbound.apiUrl = data.outbound_api_url.trim();
    }
  } catch {
    /* keep wiki/env fallbacks */
  }
}

async function loadSiteCopy(): Promise<void> {
  try {
    const res = await fetch(`/api/site_copy?_=${Date.now()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return;
    siteCopy = (await res.json()) as SiteCopy;
    if (siteCopy.rt_document_title) {
      document.title = siteCopy.rt_document_title;
    }
  } catch {
    /* keep fallbacks */
  }
}

// â”€â”€ SESSION TOKEN PRE-WARM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Minting the ephemeral key on "Start Call" blocks for ~1â€“2 s. We fetch it in
// the background on page load so it is ready the moment the user clicks.

// -- ELEVENLABS WEBRTC TOKEN PRE-WARM --
// Fetch the conversation token on page load so voice connects instantly on first click.
// Tokens expire after ~15 minutes.

// WebRTC (conversationToken) path — better browser mic support than WebSocket/AudioWorklet.
// Token prefetch is limited to strong user intent so idle page views do not consume EL capacity.
const ELEVENLABS_TOKEN_PREFETCH_ENABLED = (() => {
  const raw = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
    .VITE_ELEVENLABS_TOKEN_PREFETCH?.trim()
    .toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
})();
const ELEVENLABS_TOKEN_TTL_MS = 12 * 60 * 1000;
const VOICE_LATENCY_DEBUG = envTruthy(
  (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env
    .VITE_VOICE_LATENCY_DEBUG,
);
let _elTokenInflight: Promise<string> | null = null;
let _elTokenCache: { token: string; expiresAt: number; mintedAt: number } | null = null;
let _elBackendPrewarmStarted = false;

function voiceNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function logVoiceLatency(label: string, startedAt: number, extra: Record<string, unknown> = {}): void {
  if (!VOICE_LATENCY_DEBUG) return;
  console.debug("[voice-latency]", label, {
    elapsed_ms: Math.round(voiceNow() - startedAt),
    ...extra,
  });
}

function prewarmElevenLabsBackend(reason = "unspecified"): void {
  if (_elBackendPrewarmStarted) return;
  _elBackendPrewarmStarted = true;
  const startedAt = voiceNow();
  void fetch(`/api/elevenlabs/prewarm?source=${encodeURIComponent(reason)}`)
    .then((res) => {
      logVoiceLatency("backend_prewarm", startedAt, { ok: res.ok, status: res.status, reason });
    })
    .catch((error) => {
      logVoiceLatency("backend_prewarm_error", startedAt, { reason, error: String(error) });
    });
}

async function getElConversationToken(opts: { consume?: boolean; reason?: string } = {}): Promise<string> {
  const consume = opts.consume ?? true;
  const reason = opts.reason ?? (consume ? "start-call" : "prefetch");
  const now = Date.now();
  if (_elTokenCache && _elTokenCache.expiresAt > now + 10_000) {
    const cached = _elTokenCache;
    if (consume) _elTokenCache = null;
    logVoiceLatency("elevenlabs_token_cache_hit", cached.mintedAt, {
      age_ms: now - cached.mintedAt,
      consume,
      reason,
    });
    return cached.token;
  }
  _elTokenCache = null;

  // De-duplicate: if a fetch is already running return the same promise.
  if (_elTokenInflight) {
    const token = await _elTokenInflight;
    if (consume && _elTokenCache?.token === token) _elTokenCache = null;
    return token;
  }

  const startedAt = voiceNow();
  _elTokenInflight = (async () => {
    const res = await fetch(`/api/elevenlabs/token?source=${encodeURIComponent(reason)}`);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`ElevenLabs token error (HTTP ${res.status}): ${body || "server error"}`);
    }
    const data = (await res.json()) as { conversation_token?: string; token?: string };
    const tok = (data.conversation_token ?? data.token ?? "").trim();
    if (!tok) throw new Error("Server did not return a conversation_token for ElevenLabs.");
    _elTokenCache = {
      token: tok,
      expiresAt: Date.now() + ELEVENLABS_TOKEN_TTL_MS,
      mintedAt: Date.now(),
    };
    logVoiceLatency("elevenlabs_token_fetch", startedAt, { reason, status: res.status });
    return tok;
  })();

  try {
    const token = await _elTokenInflight;
    if (consume && _elTokenCache?.token === token) _elTokenCache = null;
    return token;
  } finally {
    _elTokenInflight = null;
  }
}

function prefetchElConversationToken(reason: string): void {
  if (!ELEVENLABS_TOKEN_PREFETCH_ENABLED) return;
  if (_elTokenCache && _elTokenCache.expiresAt > Date.now() + 10_000) return;
  if (_elTokenInflight) return;
  void getElConversationToken({ consume: false, reason: `prefetch-${reason}` }).catch((error) => {
    logVoiceLatency("elevenlabs_token_prefetch_error", voiceNow(), {
      reason,
      error: String(error),
    });
  });
}

// â”€â”€ WIKI CONTEXT PRE-FETCH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Tool round-trips add latency. Prefetch common topics at page load (one batch
// request), cache per-query results, and wait (capped) before voice connect so
// PRODUCT CONTEXT is in-session; search_wiki still runs for gaps.
const WIKI_CONNECT_WAIT_MS = 2500; // kept for API compatibility

function voiceAgentInstructions(_mode: string, _wiki: string): string {
  return ''; // handled server-side by ElevenLabs custom LLM endpoint
}

function realtimeAgentInstructions(_s: string, _m: string, _w: string): string {
  return ''; // handled server-side
}

/** Scenario sent to ElevenLabs custom LLM — always Hammer sales. */
function voiceScenarioForElevenLabs(): VoiceScenario {
  return "hammer";
}

function hammerKnowledgeToolsActive(): boolean {
  return true;
}

function applyVoiceContextFromClick(target: EventTarget | null): void {
  const el = target instanceof HTMLElement ? target : null;
  const host = el?.closest<HTMLElement>("[data-voice-scenario]");
  activeVoiceScenario = "hammer";
  homeProductVoiceFocus = host?.getAttribute("data-voice-product")?.trim() || "";
}

function resetPenOpenerState(): void {}



function resetPenHammerCloseState(): void {
  penHammerCloseActive = false;
  penChallengeSkipped = false;
  penBuyerProduct = "";
  resetPenOpenerState();
}

/** Ephemeral in-memory log for end-of-call Slack (not persisted). */
type VoiceCallSummaryState = {
  callId: string;
  startedAt: string;
  values: Record<string, string>;
  sessionLog: string[];
  interactionSummary: string;
  captureLeadFired: boolean;
  agreementEmailSent: boolean;
  iApproveApproved: boolean;
  accountCreated: boolean;
  penChallengeSkipped: boolean;
  penHammerCloseActive: boolean;
};

const VOICE_SUMMARY_MAX_LOG = 80;
const VOICE_SUMMARY_MIN_PHONE_DIGITS = 5;

function emptyVoiceCallSummary(): VoiceCallSummaryState {
  return {
    callId: "",
    startedAt: "",
    values: {},
    sessionLog: [],
    interactionSummary: "",
    captureLeadFired: false,
    agreementEmailSent: false,
    iApproveApproved: false,
    accountCreated: false,
    penChallengeSkipped: false,
    penHammerCloseActive: false,
  };
}

let voiceCallSummary: VoiceCallSummaryState = emptyVoiceCallSummary();

function resetVoiceCallSummaryState(): void {
  voiceCallSummary = emptyVoiceCallSummary();
  voiceCallSummary.startedAt = new Date().toISOString().slice(0, 19);
  voiceCallSummary.callId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `browser-${Date.now()}`;
}

function voiceCallSummarySetValue(key: string, value: string): void {
  const val = value.trim();
  if (!val) return;
  const norm = key.trim().toLowerCase();
  if (norm === "phone" || norm === "cell_phone") {
    voiceCallSummary.values.phone = val;
    return;
  }
  if (norm === "display_name" || norm === "legal_name" || norm === "dealership_name") {
    voiceCallSummary.values.dealership_name = val;
    return;
  }
  if (norm === "product" || norm === "buyer_product") {
    voiceCallSummary.values.product_interest = val;
    return;
  }
  voiceCallSummary.values[norm] = val;
}

function voiceCallSummaryAppendLog(line: string): void {
  const text = line.replace(/\s+/g, " ").trim();
  if (!text) return;
  voiceCallSummary.sessionLog.push(text);
  if (voiceCallSummary.sessionLog.length > VOICE_SUMMARY_MAX_LOG) {
    voiceCallSummary.sessionLog = voiceCallSummary.sessionLog.slice(-VOICE_SUMMARY_MAX_LOG);
  }
}



function voiceCallSummaryHasActionableContact(): boolean {
  const phone = (voiceCallSummary.values.phone ?? "").replace(/\D/g, "");
  const email = (voiceCallSummary.values.email ?? "").trim();
  return (
    phone.length >= VOICE_SUMMARY_MIN_PHONE_DIGITS ||
    email.includes("@") ||
    voiceCallSummary.captureLeadFired ||
    voiceCallSummary.agreementEmailSent ||
    Boolean(voiceCallSummary.values.name?.trim()) ||
    Boolean(voiceCallSummary.values.dealership_name?.trim())
  );
}

function postVoiceCallSummaryOnEnd(): void {
  // Always POST on end — tools run server-side (ElevenLabs LLM); client state may lack email/phone.
  // Server + ElevenLabs post-call webhook decide whether to fire Zapier.
  const body = {
    channel: "browser",
    call_id: voiceCallSummary.callId,
    started_at: voiceCallSummary.startedAt,
    ended_at: new Date().toISOString().slice(0, 19),
    session_log: voiceCallSummary.sessionLog,
    capture_lead_fired: voiceCallSummary.captureLeadFired,
    agreement_email_sent: voiceCallSummary.agreementEmailSent,
    i_approve_approved: voiceCallSummary.iApproveApproved,
    account_created: voiceCallSummary.accountCreated,
    pen_challenge_skipped: voiceCallSummary.penChallengeSkipped,
    pen_hammer_close_active: voiceCallSummary.penHammerCloseActive,
    ...voiceCallSummary.values,
  };
  const payload = JSON.stringify(body);
  const url = "/api/voice/call-summary";
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
    return;
  }
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}




function mount() {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) return;

  /** WebRTC does not emit transport `audio` chunks â†’ no `audio_start`; use server events instead. Small delay avoids flicker between back-to-back audio chunks. */
  let assistantSpeakingClearTimer: ReturnType<typeof setTimeout> | null = null;

  function clearAssistantSpeakingDebounce(): void {
    if (assistantSpeakingClearTimer !== null) {
      clearTimeout(assistantSpeakingClearTimer);
      assistantSpeakingClearTimer = null;
    }
  }

  function patchLiveVoiceUi(): void {
    if (uiState !== "live") return;
    root.querySelectorAll<HTMLElement>(".call-stack--live").forEach((el) => {
      el.classList.toggle("is-assistant-speaking", assistantSpeaking);
    });
    root.querySelectorAll<HTMLElement>("#footerPrimary.voice-live-end.is-live").forEach((el) => {
      el.classList.toggle("is-assistant-speaking", assistantSpeaking);
    });
    root.querySelectorAll<HTMLElement>(".voice-stage--live, .voice-stage").forEach((el) => {
      el.classList.toggle("is-assistant-speaking", assistantSpeaking);
    });
    root.querySelectorAll<HTMLElement>(".call-hero-zone").forEach((el) => {
      el.classList.toggle("is-assistant-speaking", assistantSpeaking);
    });
    root.querySelectorAll<HTMLElement>(".product-col-voice-stage--live").forEach((el) => {
      el.classList.toggle("is-assistant-speaking", assistantSpeaking);
    });
    root.querySelectorAll<HTMLElement>(".product-col-voice-orb__glow").forEach((el) => {
      el.classList.toggle("is-assistant-speaking", assistantSpeaking);
    });
  }

  function usesInlineFooterVoiceUi(): boolean {
    return voiceSessionAnchoredInFooter && !voiceSessionAnchoredInNavPanel;
  }

  function patchFooterVoiceCtaUi(): void {
    const btn = root.querySelector<HTMLButtonElement>("#footerCtaVoice");
    if (!btn) return;

    const connecting = uiState === "connecting";
    const live = uiState === "live";
    const ctaLabel = copy("rt_home_voice_cta", "Talk to Hannah, our voice AI");
    const endLabel = copy("rt_call_aria_end", "End call");
    const connectingLabel = copy("rt_call_aria_connecting", "Connecting…");

    btn.classList.toggle("is-connecting", connecting);
    btn.classList.toggle("is-live", live);
    btn.disabled = connecting;

    if (connecting) {
      btn.setAttribute("aria-label", connectingLabel);
    } else if (live) {
      btn.setAttribute("aria-label", endLabel);
    } else {
      btn.setAttribute("aria-label", ctaLabel);
    }

    const label = btn.querySelector(".footer-cta__pill-label");
    if (label) {
      label.textContent = live ? endLabel : ctaLabel;
    }
  }

  function refreshVoiceUi(): void {
    if (usesInlineFooterVoiceUi()) {
      patchFooterVoiceCtaUi();
      return;
    }
    if (isLandingHomeLayout()) {
      patchLandingHomeVoiceUi();
      patchCallMeModalUi();
      return;
    }
    render();
  }

  function setAssistantSpeakingUi(next: boolean): void {
    if (assistantSpeaking === next) return;
    assistantSpeaking = next;
    // Full render() replaces the entire DOM and looks like the page is reloading.
    // During a live call, only patch voice UI classes in place.
    if (uiState === "live") {
      patchLiveVoiceUi();
      return;
    }
    if (usesInlineFooterVoiceUi()) {
      patchFooterVoiceCtaUi();
      return;
    }
    if (isLandingHomeLayout()) {
      patchLandingHomeVoiceUi();
      return;
    }
    render();
  }

  function stopFooterMicVisualization(): void {
    try {
      footerMicSource?.disconnect();
    } catch {
      /* ignore */
    }
    footerMicSource = null;
    try {
      footerMicAnalyser?.disconnect();
    } catch {
      /* ignore */
    }
    footerMicAnalyser = null;
    footerMicLevelSmooth = 0;
    document.querySelectorAll<HTMLElement>(".landing-cta.mic-reactive, .footer-cta__pill.mic-reactive").forEach((cta) => {
      cta.style.removeProperty("--mic-level");
    });
    if (footerMicAudioCtx) {
      void footerMicAudioCtx.close();
      footerMicAudioCtx = null;
    }
  }

  /** Mic analyser for visitor speech â€” shared by footer CTA bars and live orb visualizer. */
  function startFooterMicVisualization(stream: MediaStream | null): void {
    stopFooterMicVisualization();
    if (!stream?.getAudioTracks().length) return;
    try {
      footerMicAudioCtx = new AudioContext();
      footerMicSource = footerMicAudioCtx.createMediaStreamSource(stream);
      footerMicAnalyser = footerMicAudioCtx.createAnalyser();
      footerMicAnalyser.fftSize = 512;
      footerMicAnalyser.smoothingTimeConstant = 0.82;
      footerMicSource.connect(footerMicAnalyser);
      void footerMicAudioCtx.resume();
    } catch {
      stopFooterMicVisualization();
    }
  }

  function stopVoiceReactiveUi(): void {
    voiceVisualizer?.stop();
    voiceVisualizer = null;
    try {
      orbAnalyser?.disconnect();
    } catch {
      /* ignore */
    }
    orbAnalyser = null;
    if (orbAudioCtx) {
      void orbAudioCtx.close();
      orbAudioCtx = null;
    }
  }

  function setupOrbAmplitude(stream: MediaStream): void {
    if (orbAudioCtx) return;
    try {
      orbAudioCtx = new AudioContext();
      const source = orbAudioCtx.createMediaStreamSource(stream);
      orbAnalyser = orbAudioCtx.createAnalyser();
      orbAnalyser.fftSize = 256;
      orbAnalyser.smoothingTimeConstant = 0.84;
      source.connect(orbAnalyser);
      void orbAudioCtx.resume();
    } catch {
      stopVoiceReactiveUi();
    }
  }

  function startVoiceReactiveUi(): void {
    voiceVisualizer?.stop();
    if (REDUCE_MOTION || uiState !== "live") return;
    voiceVisualizer = startVoiceAudioVisualizer({
      getMicAnalyser: () => footerMicAnalyser,
      getRemoteAnalyser: () => orbAnalyser,
      getAssistantSpeaking: () => assistantSpeaking,
      getIsLive: () => uiState === "live",
      getRoot: () => root,
    });
  }

  function releaseVoiceCaptureStream(): void {
    if (voiceCaptureStream) {
      for (const t of voiceCaptureStream.getTracks()) {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      }
      voiceCaptureStream = null;
    }
  }

  async function acquireVoiceCaptureStream(): Promise<MediaStream> {
    if (voiceCaptureStream) {
      const live = voiceCaptureStream.getTracks().some((t) => t.readyState === "live");
      if (live) return voiceCaptureStream;
      releaseVoiceCaptureStream();
    }
    voiceCaptureStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    return voiceCaptureStream;
  }

  function prewarmVoiceConnect(): void {
    if (!BROWSER_VOICE_ENABLED && !NAV_PANEL_VOICE_ENABLED) return;
    prewarmElevenLabsBackend("voice-connect");
    prefetchElConversationToken("voice-connect");
  }

  function scheduleVoiceIdlePrewarm(): void {
    if (preferLightMobileNetwork()) return;
    if (!BROWSER_VOICE_ENABLED && !NAV_PANEL_VOICE_ENABLED) return;
    const warm = () => prewarmElevenLabsBackend("idle");
    const win = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    };
    if (typeof win.requestIdleCallback === "function") {
      win.requestIdleCallback(warm, { timeout: 2200 });
    } else {
      window.setTimeout(warm, 900);
    }
  }

  function wireGlobalMicPrewarm(): void {
    if (preferLightMobileNetwork()) return;
    if (!BROWSER_VOICE_ENABLED && !NAV_PANEL_VOICE_ENABLED) return;
    const warmOnce = (): void => {
      if (voiceMicPrewarmStarted) return;
      voiceMicPrewarmStarted = true;
      prewarmElevenLabsBackend("global-pointerdown");
      prefetchElConversationToken("global-pointerdown");
      // Warm the lazily-split voice SDK chunk so the network fetch overlaps with
      // user intent rather than blocking the actual call start.
      void loadElevenLabsClient().catch(() => {});
      // Do NOT acquire the mic here — mic is only opened when the call actually starts.
    };
    document.addEventListener("pointerdown", warmOnce, { capture: true, once: true });
  }

  function wireVoicePrewarm(): void {
    const warm = (): void => {
      prewarmVoiceConnect();
      // Do NOT acquire the mic here — mic is only opened when the call actually starts.
    };
    for (const sel of ["#footerPrimary", "#footerCtaVoice", "#navPanelFootVoiceBtn", "#callBtnInner", ".product-col__voice"]) {
      const el = root.querySelector(sel);
      el?.addEventListener("pointerenter", warm, { passive: true });
      el?.addEventListener("pointerdown", warm, { passive: true });
      el?.addEventListener("focus", warm, { passive: true });
    }
  }

  function onKeyDown(ev: KeyboardEvent) {
    if (callMeModalOpen && ev.key === "Escape") {
      ev.preventDefault();
      callMeModalOpen = false;
      document.body.style.overflow = "";
      patchOverlayUi();
      return;
    }
    if (leadModalOpen && ev.key === "Escape") {
      ev.preventDefault();
      leadModalOpen = false;
      document.body.style.overflow = "";
      patchOverlayUi();
      return;
    }
    if (mobileNavMenuOpen && !openNavPanel && ev.key === "Escape") {
      ev.preventDefault();
      mobileNavMenuOpen = false;
      patchOverlayUi();
      return;
    }
    if (!openNavPanel) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeNavPanel();
    }
  }

  function stopNavPanelVoiceOnDismiss(): boolean {
    if (
      voiceSessionAnchoredInNavPanel &&
      (uiState === "live" || uiState === "connecting")
    ) {
      endCall();
      return true;
    }
    return false;
  }

  function closeNavPanel() {
    openNavPanel = null;
    mobileNavMenuOpen = false;
    if (!stopNavPanelVoiceOnDismiss()) patchOverlayUi();
  }

  function closeMobileNavMenu() {
    if (!mobileNavMenuOpen) return;
    mobileNavMenuOpen = false;
    patchOverlayUi();
  }

  function wireLeadModal() {
    const close = () => {
      if (!leadModalOpen) return;
      leadModalOpen = false;
      document.body.style.overflow = "";
      patchOverlayUi();
    };
    root.querySelectorAll<HTMLElement>("[data-lead-close]").forEach((el) => {
      el.addEventListener("click", close);
    });

    const form = root.querySelector<HTMLFormElement>("#leadForm");
    const submitBtn = form?.querySelector<HTMLButtonElement>(".lead-submit");
    const submitLabel = submitBtn?.querySelector<HTMLElement>(".lead-submit__label");
    const statusEl = form?.querySelector<HTMLElement>("#leadFormStatus");
    const consentInput = form?.querySelector<HTMLInputElement>("#leadConsent");
    if (consentInput && submitBtn) {
      consentInput.addEventListener("change", () => {
        leadConsentChecked = consentInput.checked;
        submitBtn.disabled = !leadConsentChecked;
      });
    }
    const setLeadStatus = (message: string, kind: "error" | "success" | "") => {
      if (!statusEl) return;
      statusEl.textContent = message;
      statusEl.classList.remove("is-error", "is-success");
      if (kind === "error") statusEl.classList.add("is-error");
      if (kind === "success") statusEl.classList.add("is-success");
    };

    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!form || !submitBtn || submitBtn.disabled) return;
      const payload = readLeadFormPayload(form);
      const validationError = validateLeadPayload(payload);
      if (validationError) {
        setLeadStatus(validationError, "error");
        return;
      }
      setLeadStatus("", "");
      const defaultLabel = submitLabel?.textContent ?? copy("rt_lead_submit", "Submit");
      submitBtn.disabled = true;
      if (submitLabel) {
        submitLabel.textContent = copy("rt_lead_submitting", "Submitting...");
      }
      try {
        const res = await fetch("/api/lead", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            channel: "website",
            ...leadAttributionFields(),
            ...(leadModalSourceProduct ? { selected_plan: leadModalSourceProduct } : {}),
          }),
        });
        if (!res.ok) throw new Error(await readHttpErrorBody(res));
        // Report the lead to Google Ads and Meta. Never let tracking block the lead itself.
        try {
          const w = window as unknown as {
            gtag?: (...args: unknown[]) => void;
            fbq?: (...args: unknown[]) => void;
          };
          w.gtag?.("event", "conversion", { send_to: "AW-16574612743/Plo9CJ2woc8aEIeKst89" });
          w.fbq?.("track", "Lead");
        } catch {
          /* ignore tracking errors */
        }
        setLeadStatus(
          copy("rt_lead_success", "Thanks! We got your info. Our team will call you shortly."),
          "success",
        );
        form.reset();
        leadConsentChecked = false;
      } catch (err) {
        console.error("[lead form]", err);
        const msg =
          err instanceof Error
            ? err.message
            : copy("rt_lead_submit_err", "Could not submit. Try again.");
        setLeadStatus(msg, "error");
      } finally {
        submitBtn.disabled = false;
        if (submitLabel) submitLabel.textContent = defaultLabel;
      }
    });

    if (leadModalOpen) {
      requestAnimationFrame(() => {
        root.querySelector<HTMLElement>("#leadModalDialog input")?.focus();
      });
    }
  }

  function wireTryButtons() {
    const openSignUpModal = (e?: Event) => {
      e?.preventDefault();
      const btn = (e?.currentTarget ?? e?.target) as HTMLElement | null;
      leadModalSourceProduct = btn?.dataset.product?.trim() ?? "";
      openNavPanel = null;
      callMeModalOpen = false;
      leadModalOpen = true;
      document.body.style.overflow = "hidden";
      if (!stopNavPanelVoiceOnDismiss()) patchOverlayUi();
    };
    root.querySelectorAll("[data-action='open-sign-up']").forEach((el) => {
      el.addEventListener("click", openSignUpModal);
    });
    if (NAV_PANEL_VOICE_ENABLED) {
      const navPanelFootBtn = root.querySelector<HTMLButtonElement>("#navPanelFootVoiceBtn");
      bindNavPanelFootTapFeedback(navPanelFootBtn);
      requestAnimationFrame(() => syncNavPanelFootHint(navPanelFootBtn));
      navPanelFootBtn?.addEventListener("click", (e) => {
        e.preventDefault();
        playNavPanelFootTapFeedback(navPanelFootBtn);
        if (uiState === "idle" || uiState === "error") {
          voiceSessionAnchoredInNavPanel = true;
          collapseHeroForLiveDemoCta = false;
          activeVoiceScenario = "hammer";
        }
        onCallClick(e, "hammer", { tapFeedbackMs: NAV_PANEL_FOOT_TAP_MS });
      });
    }
    if (outboundCallMePrimary()) {
      root.querySelector("#footerPrimary")?.addEventListener("click", (e) => {
        e.preventDefault();
        leadModalOpen = false;
        if (outboundCallUi !== "calling") {
          outboundCallUi = "idle";
          outboundCallError = "";
        }
        callMeModalOpen = true;
        document.body.style.overflow = "hidden";
        patchOverlayUi();
      });
    } else if (BROWSER_VOICE_ENABLED) {
      root.querySelector("#footerPrimary")?.addEventListener("click", (e) => {
        voiceSessionAnchoredInNavPanel = false;
        collapseHeroForLiveDemoCta = false;
        activeVoiceScenario = "hammer";
        onCallClick(e, "hammer");
      });
    }
    if (NAV_PANEL_VOICE_ENABLED) {
      root.querySelector("#footerCtaVoice")?.addEventListener("click", (e) => {
        e.preventDefault();
        voiceSessionAnchoredInNavPanel = false;
        voiceSessionAnchoredInFooter = true;
        collapseHeroForLiveDemoCta = false;
        activeVoiceScenario = "hammer";
        onCallClick(e, "hammer");
      });
    }
    root.querySelector("#footerSecondary")?.addEventListener("click", () => {
      window.open(SIGN_IN_URL, "_blank", "noopener");
    });
    wireCallMeModal();
  }

  function wireCallMeModal() {
    if (!outboundCallMePrimary()) return;
    const close = () => {
      if (!callMeModalOpen) return;
      callMeModalOpen = false;
      document.body.style.overflow = "";
      patchOverlayUi();
    };
    root.querySelectorAll<HTMLElement>("[data-call-me-close]").forEach((el) => {
      el.addEventListener("click", close);
    });

    const form = root.querySelector<HTMLFormElement>("#callMeForm");
    const phoneInput = root.querySelector<HTMLInputElement>("#callMePhone");
    const consentInput = root.querySelector<HTMLInputElement>("#callMeConsent");
    const submitBtn = form?.querySelector<HTMLButtonElement>(".call-me-modal__submit");
    if (!form || !phoneInput || !consentInput || !submitBtn) return;

    phoneInput.addEventListener("input", () => {
      outboundPhoneDraft = phoneInput.value;
      submitBtn.disabled =
        outboundCallUi === "calling" || !consentInput.checked || !phoneInput.value.trim();
    });
    consentInput.addEventListener("change", () => {
      outboundConsentChecked = consentInput.checked;
      submitBtn.disabled =
        outboundCallUi === "calling" || !outboundConsentChecked || !phoneInput.value.trim();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (outboundCallUi === "calling") return;
      outboundPhoneDraft = phoneInput.value.trim();
      outboundConsentChecked = consentInput.checked;
      if (!outboundConsentChecked) {
        outboundCallUi = "error";
        outboundCallError = copy(
          "rt_call_me_error_consent",
          "Please agree to receive the call before continuing.",
        );
        voiceUiRefresh?.();
        return;
      }
      void submitCallMeForm(outboundPhoneDraft, outboundConsentChecked);
    });

    if (callMeModalOpen && outboundCallUi !== "calling") {
      requestAnimationFrame(() => {
        root.querySelector<HTMLElement>("#callMePhone")?.focus();
      });
    }
  }

  function isLandingHomeLayout(): boolean {
    return !!root.querySelector(".landing-hero--home");
  }

  function patchOverlayUi(): void {
    syncNavPanelUrl(openNavPanel);
    syncLeadModalUrl(leadModalOpen);
    const navLayer = root.querySelector<HTMLElement>(".nav-panel-layer");
    if (navLayer) {
      const open = openNavPanel !== null;
      navLayer.classList.toggle("is-open", open);
      if (open) {
        navLayer.removeAttribute("hidden");
        navLayer.setAttribute("aria-hidden", "false");
      } else {
        navLayer.setAttribute("hidden", "");
        navLayer.setAttribute("aria-hidden", "true");
      }
    }

    const navPanel = root.querySelector<HTMLElement>(".nav-panel");
    if (navPanel) {
      navPanel.setAttribute("aria-label", navPanelAriaLabel(openNavPanel));
    }

    const kicker = root.querySelector<HTMLElement>(".nav-panel__kicker");
    if (kicker) {
      kicker.hidden = !openNavPanel || isLegalNavPanel(openNavPanel);
    }

    const titleEl = root.querySelector<HTMLElement>(".nav-panel__h");
    if (titleEl) {
      titleEl.textContent = openNavPanel ? navPanelTitle(openNavPanel) : "";
    }

    for (const [panelId, elementId] of Object.entries(NAV_PANEL_SECTION_IDS) as [NavPanelId, string][]) {
      root
        .querySelector<HTMLElement>(`#${elementId}`)
        ?.classList.toggle("is-active", openNavPanel === panelId);
    }

    // Heavy panel content is kept out of the initial HTML (page weight) and
    // only rendered when its panel is open. When a panel is opened client-side
    // (this patch path, not a full render), inject that content on first open.
    if (openNavPanel === "reviews") {
      const iframe = root.querySelector<HTMLIFrameElement>(".reviews-video__iframe");
      if (iframe && !iframe.getAttribute("src")) iframe.src = REVIEWS_YOUTUBE_EMBED;
    } else if (openNavPanel === "terms") {
      const section = root.querySelector<HTMLElement>("#navPanelTerms");
      if (section && !section.childElementCount) section.innerHTML = hammerTermsFragment;
    } else if (openNavPanel === "privacy") {
      const section = root.querySelector<HTMLElement>("#navPanelPrivacy");
      if (section && !section.childElementCount) section.innerHTML = hammerPrivacyFragment;
    }

    const navFoot = root.querySelector<HTMLElement>(".nav-panel__foot");
    if (navFoot) {
      navFoot.hidden = !openNavPanel || isLegalNavPanel(openNavPanel);
    }

    root.querySelectorAll<HTMLElement>("[data-panel]").forEach((btn) => {
      const panel = btn.dataset.panel as NavPanelId | undefined;
      const active = !!panel && openNavPanel === panel;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-expanded", active ? "true" : "false");
    });

    const leadLayer = root.querySelector<HTMLElement>(".lead-modal-layer:not(.call-me-modal-layer)");
    if (leadLayer) {
      leadLayer.classList.toggle("is-open", leadModalOpen);
      leadLayer.setAttribute("aria-hidden", leadModalOpen ? "false" : "true");
    }

    const callMeLayer = root.querySelector<HTMLElement>(".call-me-modal-layer");
    if (callMeLayer) {
      callMeLayer.classList.toggle("is-open", callMeModalOpen);
      callMeLayer.setAttribute("aria-hidden", callMeModalOpen ? "false" : "true");
    }

    document.body.style.overflow = leadModalOpen || callMeModalOpen ? "hidden" : "";

    const mobileMenu = root.querySelector<HTMLElement>(".chrome-mobile-menu");
    if (mobileMenu) {
      mobileMenu.classList.toggle("is-open", mobileNavMenuOpen);
      if (mobileNavMenuOpen) {
        mobileMenu.removeAttribute("hidden");
        mobileMenu.setAttribute("aria-hidden", "false");
      } else {
        mobileMenu.setAttribute("hidden", "");
        mobileMenu.setAttribute("aria-hidden", "true");
      }
    }

    const menuToggle = root.querySelector<HTMLButtonElement>("#chromeMenuToggle");
    if (menuToggle) {
      menuToggle.classList.toggle("is-open", mobileNavMenuOpen);
      menuToggle.setAttribute("aria-expanded", mobileNavMenuOpen ? "true" : "false");
    }

    if (leadModalOpen) {
      requestAnimationFrame(() => {
        root.querySelector<HTMLElement>("#leadModalDialog input")?.focus();
      });
    } else if (callMeModalOpen) {
      requestAnimationFrame(() => {
        root.querySelector<HTMLElement>("#callMePhone")?.focus();
      });
    }

    if (openNavPanel === "support") {
      void mountHubSpotSupportForm(root.querySelector<HTMLElement>("#hubspotSupportForm"));
    }
  }

  function patchNavPanelFootVoiceUi(): void {
    const btn = root.querySelector<HTMLButtonElement>("#navPanelFootVoiceBtn");
    if (!btn) return;

    const live = uiState === "live";
    const connecting = uiState === "connecting";
    const voiceError = voiceSessionAnchoredInNavPanel && uiState === "error";
    const eyebrowNav = voiceError
      ? copy("rt_nav_panel_foot_eyebrow_error", "Could not connect")
      : live
        ? copy("rt_nav_panel_foot_eyebrow_live", "Voice live")
        : connecting
          ? copy("rt_nav_panel_foot_eyebrow_connecting", "Connecting")
          : copy("rt_nav_panel_foot_tag", "Live voice demo");
    const hintNav = voiceError
      ? voiceConnectErrorMessage(errorDetail)
      : live
        ? copy(
            "rt_nav_panel_foot_hint_live",
            "You're connected. Speak when you're ready. Tap again to end the call.",
          )
        : connecting
          ? copy(
              "rt_nav_panel_foot_hint_connecting",
              "Securing your voice session. Allow microphone when prompted.",
            )
          : copy(
              "rt_nav_panel_foot",
              "Hannah is an AI voice assistant. This session may be recorded and processed. Ask about pricing, integrations, or sign up now.",
            );
    const ariaLabelNav = voiceError
      ? copy("rt_nav_panel_foot_voice_aria_retry", "Retry live voice demo")
      : live
        ? copy("rt_call_aria_end", "End call")
        : connecting
          ? copy("rt_call_aria_connecting", "Connecting")
          : copy("rt_nav_panel_foot_voice_aria", "Start live voice demo in this panel");

    btn.classList.toggle("is-voice-live", live);
    btn.classList.toggle("is-voice-connecting", connecting);
    btn.classList.toggle("is-voice-error", voiceError);
    btn.disabled = connecting;
    btn.setAttribute("aria-label", ariaLabelNav);

    btn.querySelector(".nav-panel__foot-signal")?.classList.toggle("is-live", live);
    btn.querySelector(".nav-panel__foot-signal")?.classList.toggle("is-connecting", connecting);
    btn.querySelector(".nav-panel__foot-orbit")?.classList.toggle("is-live", live);
    btn.querySelector(".nav-panel__foot-orbit")?.classList.toggle("is-connecting", connecting);

    const eyebrow = btn.querySelector(".nav-panel__foot-eyebrow");
    const hint = btn.querySelector(".nav-panel__foot-hint");
    if (eyebrow) eyebrow.textContent = eyebrowNav;
    if (hint) hint.textContent = hintNav;
    syncNavPanelFootHint(btn);
  }

  function patchLandingHomeVoiceUi(): void {
    patchFooterVoiceCtaUi();
    patchNavPanelFootVoiceUi();

    const live = uiState === "live";
    const connecting = uiState === "connecting";
    const activeProduct = live || connecting ? homeProductVoiceFocus : "";

    root.querySelectorAll<HTMLElement>(".product-col[data-voice-product]").forEach((col) => {
      const isActive = !!activeProduct && col.dataset.voiceProduct === activeProduct;
      col.classList.toggle("is-voice-session", isActive);
    });

    if (live || connecting) {
      focusActiveProductColVoice();
    }
  }

  function patchCallMeModalUi(): void {
    const layer = root.querySelector<HTMLElement>(".call-me-modal-layer");
    if (!layer) return;

    layer.classList.toggle("is-open", callMeModalOpen);
    layer.setAttribute("aria-hidden", callMeModalOpen ? "false" : "true");

    const busy = outboundCallUi === "calling";
    const submitBtn = root.querySelector<HTMLButtonElement>(".call-me-modal__submit");
    const submitLabel = submitBtn?.querySelector<HTMLElement>(".lead-submit__label");
    const phoneInput = root.querySelector<HTMLInputElement>("#callMePhone");
    const consentInput = root.querySelector<HTMLInputElement>("#callMeConsent");
    const statusEl = root.querySelector<HTMLElement>("#callMeStatus");

    if (submitLabel) {
      submitLabel.textContent = busy
        ? copy("rt_call_me_submitting", "Calling…")
        : copy("rt_call_me_submit", "Call me");
    }
    if (submitBtn) {
      submitBtn.disabled = busy || !outboundConsentChecked || !outboundPhoneDraft.trim();
    }
    if (phoneInput) {
      phoneInput.disabled = busy;
      if (phoneInput.value !== outboundPhoneDraft) {
        phoneInput.value = outboundPhoneDraft;
      }
    }
    if (consentInput) {
      consentInput.disabled = busy;
      consentInput.checked = outboundConsentChecked;
    }
    if (statusEl) {
      const message = outboundStatusMessage();
      statusEl.textContent = message;
      statusEl.classList.remove("is-error", "is-success", "is-pending", "has-message");
      if (outboundCallUi === "error") statusEl.classList.add("is-error");
      if (outboundCallUi === "answered") statusEl.classList.add("is-success");
      if (outboundCallUi === "calling") statusEl.classList.add("is-pending");
      if (message) statusEl.classList.add("has-message");
    }
  }

  // True until the first render() call. The prerendered snapshot in the HTML
  // was captured from this same template (scripts/prerender.mjs), so the first
  // render can usually keep the existing DOM instead of wiping and rebuilding
  // it — that wipe repainted the hero at script-boot time and pushed mobile
  // LCP from ~2.8s (first paint) to ~6s.
  let bootHydrationPending = true;

  function render() {
    const live = BROWSER_VOICE_ENABLED && uiState === "live";
    const connecting = BROWSER_VOICE_ENABLED && uiState === "connecting";
    const navPanelVoiceLive = NAV_PANEL_VOICE_ENABLED && uiState === "live";
    const navPanelVoiceConnecting = NAV_PANEL_VOICE_ENABLED && uiState === "connecting";
    const navPanelVoiceError =
      NAV_PANEL_VOICE_ENABLED && voiceSessionAnchoredInNavPanel && uiState === "error";
    const validateLaneActive = uiState === "idle";
    const resolveLaneActive =
      BROWSER_VOICE_ENABLED &&
      (uiState === "connecting" || uiState === "live" || uiState === "error");
    const shellHtml = `
      <div class="app-shell app-shell--landing">
        <div class="hero-scene" aria-hidden="true">
          <div class="hero-scene__sky"></div>
          <div class="hero-scene__aurora" aria-hidden="true">
            <span class="hero-scene__aurora-band hero-scene__aurora-band--a"></span>
            <span class="hero-scene__aurora-band hero-scene__aurora-band--b"></span>
            <span class="hero-scene__aurora-band hero-scene__aurora-band--c"></span>
          </div>
          <div class="hero-scene__orbs" aria-hidden="true">
            <span class="hero-scene__orb hero-scene__orb--1"></span>
            <span class="hero-scene__orb hero-scene__orb--2"></span>
            <span class="hero-scene__orb hero-scene__orb--3"></span>
            <span class="hero-scene__orb hero-scene__orb--4"></span>
          </div>
          ${heroNetworkSvg}
          <div class="hero-scene__sphere"></div>
          <div class="hero-scene__ground"></div>
          <div class="hero-scene__device"></div>
          <div class="hero-scene__grain" aria-hidden="true"></div>
          <div class="hero-scene__vignette" aria-hidden="true"></div>
        </div>

        <div class="underlay underlay--landing" aria-hidden="true">
          <div class="underlay__base"></div>
          <div class="underlay__liquid underlay__liquid--a"></div>
          <div class="underlay__liquid underlay__liquid--b"></div>
          <div class="underlay__liquid underlay__liquid--c"></div>
          <div class="underlay__glow"></div>
        </div>

        <header class="chrome">
          <a class="chrome__brand-link" href="${import.meta.env.BASE_URL}" aria-label="${escapeHtml(copy("rt_brand_aria", "Hammer"))}">
            <span class="logo-img logo-img--hammer" role="img" aria-label="${escapeHtml(copy("rt_logo_text", "HAMMER"))}"></span>
          </a>
          ${CHROME_NAV_SECTIONS.length ? `<nav class="chrome__nav" aria-label="${escapeHtml(copy("rt_nav_aria", "Sections"))}">
            ${renderChromeNavJumpButtons()}
          </nav>` : ""}
          <div class="chrome__actions">
            ${renderChromeSignUpButton({ extraClass: "chrome__jump--signup", dataAction: "open-sign-up" })}
            ${renderChromeLoginLink()}
            ${renderChromeSalesPhone()}
          </div>
          ${CHROME_NAV_SECTIONS.length ? `<button type="button" class="chrome__menu-toggle${mobileNavMenuOpen ? " is-open" : ""}" id="chromeMenuToggle"
            aria-expanded="${mobileNavMenuOpen}" aria-controls="chromeMobileMenu"
            aria-label="${escapeHtml(mobileNavMenuOpen ? copy("rt_nav_menu_close_aria", "Close menu") : copy("rt_nav_menu_open_aria", "Open menu"))}">
            <span class="chrome__menu-icon" aria-hidden="true"></span>
          </button>` : ""}
        </header>

        ${CHROME_NAV_SECTIONS.length ? `<div class="chrome-mobile-menu${mobileNavMenuOpen ? " is-open" : ""}" id="chromeMobileMenu"
          ${mobileNavMenuOpen ? "" : "hidden"} aria-hidden="${mobileNavMenuOpen ? "false" : "true"}">
          <button type="button" class="chrome-mobile-menu__backdrop" data-action="close-mobile-menu" tabindex="-1"
            aria-label="${escapeHtml(copy("rt_nav_menu_close_aria", "Close menu"))}"></button>
          <nav class="chrome-mobile-menu__sheet" aria-label="${escapeHtml(copy("rt_nav_aria", "Sections"))}">
            ${renderChromeNavJumpButtons("chrome__jump--mobile")}
          </nav>
        </div>` : ""}

        <div class="nav-panel-layer ${openNavPanel ? "is-open" : ""}" ${openNavPanel ? "" : "hidden"} aria-hidden="${openNavPanel ? "false" : "true"}">
          <div class="nav-panel-backdrop" data-action="close" aria-hidden="true"></div>
          <section class="nav-panel nav-panel--glass" role="dialog" aria-modal="false" aria-label="${escapeHtml(navPanelAriaLabel(openNavPanel))}">
            <div class="nav-panel__shine" aria-hidden="true"></div>
            <span class="nav-panel__accent" aria-hidden="true"></span>
            <span class="nav-panel__grid" aria-hidden="true"></span>
            <header class="nav-panel__head">
              <div class="nav-panel__title">
                <span class="nav-panel__kicker"${!openNavPanel || isLegalNavPanel(openNavPanel) ? " hidden" : ""}>
                  <span class="nav-panel__kicker-dot" aria-hidden="true"></span>
                  ${escapeHtml(copy("rt_nav_panel_kicker", "Quick tour"))}
                </span>
                <span class="nav-panel__h">${openNavPanel ? escapeHtml(navPanelTitle(openNavPanel)) : ""}</span>
              </div>
              <button type="button" class="nav-panel__close" data-action="close" aria-label="${escapeHtml(copy("rt_nav_close_aria", "Close"))}">
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>
              </button>
            </header>
            <div class="nav-panel__body">
              <div id="navPanelReviews" class="nav-panel__section ${openNavPanel === "reviews" ? "is-active" : ""}">
                <p class="nav-panel__lead nav-panel__lead--reviews">${escapeHtml(copy("rt_nav_panel_reviews_lead", "What dealers are saying."))}</p>
                <div class="reviews-video">
                  <div class="reviews-video__frame">
                    <iframe
                      class="reviews-video__iframe"
                      ${openNavPanel === "reviews" ? `src="${REVIEWS_YOUTUBE_EMBED}"` : ""}
                      title="Customer testimonial"
                      frameborder="0"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowfullscreen
                    ></iframe>
                  </div>
                  <p class="reviews-video__caption">Customer spotlight</p>
                </div>
                <div class="nav-panel__features">
                  <article class="nav-panel__feature nav-panel__feature--review">
                    <span class="nav-panel__review-mark" aria-hidden="true">&#x201C;</span>
                    <p class="nav-panel__review-quote">I was actually recommending Hammer to someone else recently, and while I was talking, it booked two appointments right in front of us. That kind of instant impact speaks for itself.</p>
                    <footer class="nav-panel__review-footer">
                      <div class="nav-panel__review-meta">
                        <span class="nav-panel__review-name">Brandon</span>
                        <span class="nav-panel__review-dealer">Keweenaw Chevy</span>
                      </div>
                      <span class="nav-panel__review-stars" aria-label="5 out of 5 stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
                    </footer>
                  </article>
                  <article class="nav-panel__feature nav-panel__feature--review">
                    <span class="nav-panel__review-mark" aria-hidden="true">&#x201C;</span>
                    <p class="nav-panel__review-quote">We've been using Hammer at Peltier Kia Tyler to manage our leads, and the results have been fantastic! Hammer has significantly improved our response times and has been instrumental in booking numerous appointments.</p>
                    <footer class="nav-panel__review-footer">
                      <div class="nav-panel__review-meta">
                        <span class="nav-panel__review-name">Brittany</span>
                        <span class="nav-panel__review-dealer">Peltier Kia Tyler</span>
                      </div>
                      <span class="nav-panel__review-stars" aria-label="5 out of 5 stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
                    </footer>
                  </article>
                  <article class="nav-panel__feature nav-panel__feature--review">
                    <span class="nav-panel__review-mark" aria-hidden="true">&#x201C;</span>
                    <p class="nav-panel__review-quote">So far a month in we've loved the service. Response time has been sub 5 seconds. AI responses have been very good and the support team and account managers are very easy to get ahold of.</p>
                    <footer class="nav-panel__review-footer">
                      <div class="nav-panel__review-meta">
                        <span class="nav-panel__review-name">Bryce</span>
                        <span class="nav-panel__review-dealer">Turpin CDJR</span>
                      </div>
                      <span class="nav-panel__review-stars" aria-label="5 out of 5 stars">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
                    </footer>
                  </article>
                </div>
              </div>
              <div id="navPanelFaq" class="nav-panel__section ${openNavPanel === "faq" ? "is-active" : ""}">
                <p class="nav-panel__lead">${escapeHtml(copy("rt_nav_panel_faq_1", "Quick answers."))}</p>
                <div class="nav-panel__faq">
                  <article class="nav-panel__faq-item">
                    <h3 class="nav-panel__faq-q">${escapeHtml(copy("rt_nav_panel_faq_q1", "What does Hammer do?"))}</h3>
                    <p class="nav-panel__faq-a">${escapeHtml(copy("rt_nav_panel_faq_a1", "Texts your leads instantly and follows up for months. Your team closes the deal."))}</p>
                  </article>
                  <article class="nav-panel__faq-item">
                    <h3 class="nav-panel__faq-q">${escapeHtml(copy("rt_nav_panel_faq_q2", "Does it replace my BDC?"))}</h3>
                    <p class="nav-panel__faq-a">${escapeHtml(copy("rt_nav_panel_faq_a2", "No. Hammer handles the first reply and follow-up. Your team closes."))}</p>
                  </article>
                  <article class="nav-panel__faq-item">
                    <h3 class="nav-panel__faq-q">${escapeHtml(copy("rt_nav_panel_faq_q3", "Will it work with our CRM?"))}</h3>
                    <p class="nav-panel__faq-a">${escapeHtml(copy("rt_nav_panel_faq_a3", "Yes, it works with the CRM you already have."))}</p>
                  </article>
                  <article class="nav-panel__faq-item">
                    <h3 class="nav-panel__faq-q">${escapeHtml(copy("rt_nav_panel_faq_q4", "How fast can we go live?"))}</h3>
                    <p class="nav-panel__faq-a">${escapeHtml(copy("rt_nav_panel_faq_a4", "Most stores go live in under 72 business hours once onboarding and feeds are connected."))}</p>
                  </article>
                  <article class="nav-panel__faq-item">
                    <h3 class="nav-panel__faq-q">${escapeHtml(copy("rt_nav_panel_faq_q5", "Is Hammer the same as HammerAI or hammer.ai?"))}</h3>
                    <p class="nav-panel__faq-a">${escapeHtml(copy("rt_nav_panel_faq_a5", "No. Hammer (Hammer Corp) builds AI for car dealerships at hammertime.com. HammerAI at hammerai.com is a consumer roleplay chat app. We are not that product, and we are not hammer.ai. If you sell cars and want leads answered, you want us."))}</p>
                  </article>
                </div>
              </div>
              <div id="navPanelSupport" class="nav-panel__section nav-panel__section--support ${openNavPanel === "support" ? "is-active" : ""}">
                <p class="nav-panel__lead">${escapeHtml(copy("rt_nav_panel_support_lead", "Tell us how we can help. Our team will get back to you shortly."))}</p>
                <p class="nav-panel__lead nav-panel__lead--contact-email">${escapeHtml(copy("rt_nav_panel_support_email_prefix", "Email us at"))} <a class="nav-panel__contact-link" href="mailto:support@hammertime.com">support@hammertime.com</a> ${escapeHtml(copy("rt_nav_panel_support_phone_prefix", "or call"))} <a class="nav-panel__contact-link" href="tel:+15128831336">(512) 883-1336</a>.</p>
                <div id="hubspotSupportForm" class="hubspot-support-form" aria-live="polite"></div>
              </div>
              <div id="navPanelAbout" class="nav-panel__section nav-panel__section--about ${openNavPanel === "about" ? "is-active" : ""}">
                <p class="nav-panel__lead">${escapeHtml(
                  copy(
                    "rt_footer_about_p1",
                    "Hammer Corp is a software company based in Austin, Texas. We build AI tools that help car dealerships answer leads fast, follow up, and book more appointments — day and night.",
                  ),
                )}</p>
                <p class="nav-panel__lead">${escapeHtml(
                  copy(
                    "rt_footer_about_p2",
                    "Dealers use Hammer to reply to every lead in seconds, keep following up when buyers go quiet, and log everything in the CRM they already use.",
                  ),
                )}</p>
                <p class="nav-panel__lead nav-panel__lead--contact-email">
                  <a class="nav-panel__contact-link" href="mailto:support@hammertime.com">support@hammertime.com</a>
                  <span aria-hidden="true"> · </span>
                  <a class="nav-panel__contact-link" href="tel:+15128831336">(512) 883-1336</a>
                  <br />
                  ${escapeHtml(copy("rt_footer_about_addr", "Hammer Corp · 1401 Lavaca St, Suite 41100, Austin, TX 78701"))}
                </p>
              </div>
              <div id="navPanelTerms" class="nav-panel__section ${openNavPanel === "terms" ? "is-active" : ""}">
                ${openNavPanel === "terms" ? hammerTermsFragment : ""}
              </div>
              <div id="navPanelPrivacy" class="nav-panel__section ${openNavPanel === "privacy" ? "is-active" : ""}">
                ${openNavPanel === "privacy" ? hammerPrivacyFragment : ""}
              </div>
            </div>
            ${renderNavPanelFootHtml()}
          </section>
        </div>

        <main class="landing-main">
          <section class="landing-hero landing-hero--home" aria-label="${escapeHtml(copy("rt_home_section_aria", "Hammer products"))}">
            ${renderHomeHeroHtml()}
            <div class="landing-home__products">
              <p class="landing-home__products-kicker">${escapeHtml(copy("rt_home_products_kicker", "Products"))}</p>
              ${renderProductColumnsHtml(
                PRODUCT_COL_VOICE_ENABLED && uiState === "live",
                PRODUCT_COL_VOICE_ENABLED && uiState === "connecting",
              )}
            </div>
          </section>
          <div class="footer-cta">
            ${renderFooterCtaHtml(navPanelVoiceLive, navPanelVoiceConnecting)}
          </div>
        </main>
        <footer class="site-footer" role="contentinfo">
          <nav class="site-footer__nav" aria-label="${escapeHtml(copy("rt_site_footer_aria", "Legal and account"))}">
            <div class="site-footer__legal">
              <a href="/about" class="chrome__jump chrome__jump--panel${openNavPanel === "about" ? " is-active" : ""}" data-panel="about" aria-expanded="${openNavPanel === "about"}" aria-controls="navPanelAbout" id="footerOpenAbout">${escapeHtml(copy("rt_footer_about_h", "About Us"))}</a>
              <a href="/terms" class="chrome__jump chrome__jump--panel${openNavPanel === "terms" ? " is-active" : ""}" data-panel="terms" aria-expanded="${openNavPanel === "terms"}" aria-controls="navPanelTerms" id="footerOpenTerms">${escapeHtml(copy("rt_site_footer_terms", "Terms of Service"))}</a>
              <a href="/privacy" class="chrome__jump chrome__jump--panel${openNavPanel === "privacy" ? " is-active" : ""}" data-panel="privacy" aria-expanded="${openNavPanel === "privacy"}" aria-controls="navPanelPrivacy" id="footerOpenPrivacy">${escapeHtml(copy("rt_site_footer_privacy", "Privacy Policy"))}</a>
            </div>
            <div class="site-footer__reviews">
              ${renderFooterReviewsButton()}
              <a href="/guides" class="chrome__jump" id="footerOpenGuides">${escapeHtml(copy("rt_site_footer_guides", "Guides"))}</a>
              <a href="/help" class="chrome__jump" id="footerOpenSupport">${escapeHtml(copy("rt_site_footer_support", "Contact Support"))}</a>
            </div>
          </nav>
        </footer>
        <div class="lead-modal-layer${leadModalOpen ? " is-open" : ""}" aria-hidden="${leadModalOpen ? "false" : "true"}">
          <div class="lead-modal-backdrop" data-lead-close tabindex="-1" aria-hidden="true"></div>
          <div
            class="lead-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="leadModalTitle"
            id="leadModalDialog">
            <div class="lead-modal__glow" aria-hidden="true"></div>
            <button type="button" class="lead-modal__close" data-lead-close aria-label="${escapeHtml(copy("rt_lead_modal_close_aria", "Close"))}">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></svg>
            </button>
            <h2 id="leadModalTitle" class="lead-modal__title">${escapeHtml(copy("rt_lead_modal_title", "Get started with Hammer"))}</h2>
            <form class="lead-modal__form" id="leadForm" novalidate>
              <label class="lead-field">
                <span class="lead-field__label">${escapeHtml(copy("rt_lead_field_name", "Name"))} <span class="lead-req" aria-hidden="true">*</span></span>
                <input type="text" name="name" class="lead-input" autocomplete="name" required maxlength="120"
                  aria-required="true" />
              </label>
              <label class="lead-field">
                <span class="lead-field__label">${escapeHtml(copy("rt_lead_field_phone", "Phone"))} <span class="lead-req" aria-hidden="true">*</span></span>
                <input type="tel" name="phone" class="lead-input" autocomplete="tel" required inputmode="tel" maxlength="32"
                  placeholder="${escapeHtml(copy("rt_lead_phone_ph", "(555) 010-1234"))}" aria-required="true" />
              </label>
              <label class="lead-field">
                <span class="lead-field__label">${escapeHtml(copy("rt_lead_field_website", "Dealership Website"))} <span class="lead-req" aria-hidden="true">*</span></span>
                <input type="text" name="website" class="lead-input" autocomplete="url" required maxlength="300"
                  placeholder="${escapeHtml(copy("rt_lead_website_ph", "yourdealership.com"))}" aria-required="true"
                  inputmode="url" />
              </label>
              <label class="call-me-modal__consent lead-modal__consent">
                <input type="checkbox" class="call-me-modal__checkbox" id="leadConsent" name="consent"
                  ${leadConsentChecked ? "checked" : ""}
                  required />
                <span class="call-me-modal__consent-text">${escapeHtml(copy("rt_lead_consent", "I agree to receive automated marketing & account calls and texts from Hammer at this number. Consent isn't required to buy. Frequency varies; msg & data rates may apply. Reply STOP to cancel, HELP for help."))}</span>
              </label>
              <p id="leadFormStatus" class="lead-form-status" role="status" aria-live="polite"></p>
              <button type="submit" class="lead-submit"${leadConsentChecked ? "" : " disabled"}><span class="lead-submit__label">${escapeHtml(copy("rt_lead_submit", "Get Started"))}</span></button>
            </form>
            <div class="lead-google-badge">
              <div class="lead-google-badge__row">
                <span class="lead-google-badge__brand">
                  <svg class="lead-google-badge__g" viewBox="0 0 24 24" aria-hidden="true" width="20" height="20">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                  </svg>
                  ${escapeHtml(copy("rt_lead_google_wordmark", "Google"))}
                </span>
                <span class="lead-google-badge__stars" aria-hidden="true">&#9733;&#9733;&#9733;&#9733;&#9733;</span>
                <span class="lead-google-badge__score">${escapeHtml(copy("rt_lead_rating", "4.6"))}</span>
                <span class="lead-google-badge__reviews">${escapeHtml(copy("rt_lead_reviews_line", "266 reviews"))}</span>
              </div>
            </div>
          </div>
        </div>
        ${renderCallMeModalHtml()}
      </div>`;

    if (bootHydrationPending) {
      bootHydrationPending = false;
      // Parse the template detached so the browser normalizes it exactly like
      // it normalized the injected snapshot; strip the snapshot's banner
      // comment before comparing. On match, skip the innerHTML wipe and just
      // (re)wire event handlers on the DOM that is already on screen. On any
      // mismatch, fall back to the normal full render.
      const stripComments = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "").trim();
      const probe = document.createElement("div");
      probe.innerHTML = shellHtml;
      if (stripComments(probe.innerHTML) === stripComments(root.innerHTML)) {
        root.dataset.hydrated = "match";
      } else {
        root.dataset.hydrated = "replace";
        root.innerHTML = shellHtml;
      }
    } else {
      root.innerHTML = shellHtml;
    }

    root.querySelectorAll<HTMLElement>("[data-panel]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const panel = btn.dataset.panel as NavPanelId | undefined;
        if (!panel) return;
        leadModalOpen = false;
        callMeModalOpen = false;
        document.body.style.overflow = "";
        const closingPanel = openNavPanel === panel;
        mobileNavMenuOpen = false;
        openNavPanel = closingPanel ? null : panel;
        if (closingPanel) {
          if (!stopNavPanelVoiceOnDismiss()) patchOverlayUi();
        } else {
          if (openNavPanel && NAV_PANEL_VOICE_ENABLED) prewarmVoiceConnect();
          patchOverlayUi();
        }
      });
    });

    root.querySelectorAll<HTMLElement>("[data-action=\"close\"]").forEach((el) => {
      el.addEventListener("click", () => {
        leadModalOpen = false;
        document.body.style.overflow = "";
        closeNavPanel();
      });
    });

    root.querySelectorAll<HTMLElement>("[data-action=\"close-mobile-menu\"]").forEach((el) => {
      el.addEventListener("click", () => closeMobileNavMenu());
    });

    root.querySelector("#chromeMenuToggle")?.addEventListener("click", (e) => {
      e.preventDefault();
      mobileNavMenuOpen = !mobileNavMenuOpen;
      patchOverlayUi();
    });

    if (BROWSER_VOICE_ENABLED) {
      root.querySelector("#callBtnInner")?.addEventListener("click", (e) => {
        voiceSessionAnchoredInNavPanel = false;
        collapseHeroForLiveDemoCta = false;
        activeVoiceScenario = "hammer";
        onCallClick(e, "hammer");
      });

      // Make the entire shell orbit area clickable, not just the inner button pill.
      // Guard: skip if the click already came from the inner button (would double-fire).
      const callShell = root.querySelector<HTMLElement>(".btn-call-shell");
      if (callShell) {
        callShell.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("#callBtnInner")) return;
          voiceSessionAnchoredInNavPanel = false;
          collapseHeroForLiveDemoCta = false;
          activeVoiceScenario = "hammer";
          onCallClick(e, "hammer");
        });
      }
    }

    wireTryButtons();
    wireVoicePrewarm();
    wireGlobalMicPrewarm();
    scheduleVoiceIdlePrewarm();
    wireLeadModal();
    voiceUiRefresh = refreshVoiceUi;
    focusActiveProductColVoice();
    patchOverlayUi();
  }

  function focusActiveProductColVoice(): void {
    if (!homeProductVoiceFocus || (uiState !== "connecting" && uiState !== "live")) return;
    requestAnimationFrame(() => {
      const cols = root.querySelectorAll<HTMLElement>(".product-col.is-voice-session");
      const col =
        [...cols].find((el) => el.dataset.voiceProduct === homeProductVoiceFocus) ?? cols[0];
      col?.scrollIntoView({
        behavior: REDUCE_MOTION ? "auto" : "smooth",
        block: "nearest",
      });
    });
  }

  async function startCall(opts?: { tapFeedbackMs?: number }) {
    if (uiState === "connecting" || uiState === "live") return;
    const callStartedAt = voiceNow();
    const callEpoch = ++voiceCallEpoch;
    resetPenHammerCloseState();
    resetVoiceCallSummaryState();
    uiState = "connecting";
    errorDetail = "";
    statusText = copy("rt_status_connecting", "Connecting voice…");
    await delayForTapFeedback(opts?.tapFeedbackMs);
    logVoiceLatency("tap_feedback", callStartedAt);
    refreshVoiceUi();

    try {
      // Fetch token + warm wiki/GPT context in parallel while the UI shows connecting.
      prewarmElevenLabsBackend("start-call");
      const tokenStartedAt = voiceNow();
      const conversationToken = await getElConversationToken({
        consume: true,
        reason: "start-call",
      });
      logVoiceLatency("token_ready_for_start", tokenStartedAt);

      if (callEpoch !== voiceCallEpoch) return;

      const llmScenario = voiceScenarioForElevenLabs();
      const startSessionStartedAt = voiceNow();
      let firstSpeakingLogged = false;

      // Type cast wrappers for ElevenLabs SDK callbacks (SDK uses 'unknown' params in some builds)
      type ConnectCb = (props: { conversationId: string }) => void;
      type ModeCb   = (props: { mode: "speaking" | "listening" }) => void;
      type ErrCb    = (message: string, context?: unknown) => void;

      const { VoiceConversation: Conversation } = await loadElevenLabsClient();
      const conv = await Conversation.startSession({
        conversationToken,
        connectionType: "webrtc",
        customLlmExtraBody: {
          voice_scenario: llmScenario,
          ...(homeProductVoiceFocus ? { hammer_product: homeProductVoiceFocus } : {}),
        },
        connectionDelay: {
          android: 0,
          ios: 0,
          default: 0,
        },

        onConnect: (({ conversationId }: { conversationId: string }) => {
          if (callEpoch !== voiceCallEpoch) { void conv.endSession(); return; }
          logVoiceLatency("webrtc_on_connect", callStartedAt, {
            conversationId,
            start_session_ms: Math.round(voiceNow() - startSessionStartedAt),
          });
          voiceCallSummary.callId = conversationId;
          voiceCallSummary.startedAt = new Date().toISOString().slice(0, 19);

          // Register with the admin dashboard immediately so "Active Now" and
          // the live activity feed update before the first user turn is processed.
          void fetch("/api/voice/browser-call-start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              conversation_id: conversationId,
              scenario: llmScenario,
              channel: "elevenlabs_browser",
            }),
          }).catch(() => {});

          uiState = "live";
          if (homeProductVoiceFocus) {
            collapseHeroForLiveDemoCta = false;
          } else if (usesInlineFooterVoiceUi()) {
            collapseHeroForLiveDemoCta = false;
          } else {
            collapseHeroForLiveDemoCta = true;
          }
          statusText = homeProductVoiceFocus
              ? copy(
                  "rt_status_live_product",
                  "Live. Hannah is listening. Ask about {product}.",
                ).replace("{product}", homeProductVoiceFocus)
              : copy("rt_status_live", "Live. Speak anytime. Tap the circle to end the call.");
          startVoiceReactiveUi();
          refreshVoiceUi();
        }) as ConnectCb,

        onDisconnect: ((details) => {
          if (callEpoch !== voiceCallEpoch) return;
          clearAssistantSpeakingDebounce();
          stopVoiceReactiveUi();
          releaseVoiceCaptureStream();
          postVoiceCallSummaryOnEnd();
          assistantSpeaking = false;
          collapseHeroForLiveDemoCta = false;
          voiceSessionAnchoredInNavPanel = false;
          session = null;
          if (uiState === "connecting") {
            uiState = "error";
            applyVoiceConnectErrorDetail(
              details && typeof details === "object" && "message" in details
                ? (details as { message?: string }).message
                : details,
            );
          } else if (
            uiState === "live" &&
            details &&
            typeof details === "object" &&
            "reason" in details &&
            (details as { reason?: string }).reason === "error"
          ) {
            uiState = "error";
            applyVoiceConnectErrorDetail((details as { message?: string }).message ?? details);
          } else {
            uiState = "idle";
            errorDetail = "";
            statusText = copy("rt_status_call_ended", "Call ended. Start again when you are ready.");
          }
          refreshVoiceUi();
        }),

        onModeChange: (({ mode }: { mode: "speaking" | "listening" }) => {
          clearAssistantSpeakingDebounce();
          if (mode === "speaking" && !firstSpeakingLogged) {
            firstSpeakingLogged = true;
            logVoiceLatency("first_speaking", callStartedAt);
          }
          setAssistantSpeakingUi(mode === "speaking");
        }) as ModeCb,

        onError: ((message: string) => {
          console.error("ElevenLabs session error:", message);
          clearAssistantSpeakingDebounce();
          assistantSpeaking = false;
          collapseHeroForLiveDemoCta = false;
          stopVoiceReactiveUi();
          releaseVoiceCaptureStream();
          if (callEpoch === voiceCallEpoch) {
            uiState = "error";
            errorDetail = String(message);
            session = null;
            refreshVoiceUi();
          }
        }) as ErrCb,

        onDebug: (info: unknown) => {
          console.debug("[EL debug]", info);
        },
      });

      if (callEpoch !== voiceCallEpoch) { void conv.endSession(); return; }
      session = conv;

    } catch (e) {
      console.error(e);
      clearAssistantSpeakingDebounce();
      assistantSpeaking = false;
      collapseHeroForLiveDemoCta = false;
      stopVoiceReactiveUi();
      releaseVoiceCaptureStream();
      uiState = "error";
      errorDetail = String(e instanceof Error ? e.message : String(e));
      session = null;
      refreshVoiceUi();
    }
  }

  function endCall(opts?: { tapFeedbackMs?: number }) {
    const wasFooterVoice = usesInlineFooterVoiceUi();
    voiceCallEpoch += 1;
    clearAssistantSpeakingDebounce();
    stopVoiceReactiveUi();
    releaseVoiceCaptureStream();
    resetPenHammerCloseState();
    if (session) {
      void session.endSession();
      session = null;
    }
    assistantSpeaking = false;
    collapseHeroForLiveDemoCta = false;
    voiceSessionAnchoredInNavPanel = false;
    voiceSessionAnchoredInFooter = false;
    homeProductVoiceFocus = "";
    uiState = "idle";
    errorDetail = "";
    statusText = copy("rt_status_call_ended", "Call ended. Start again when you are ready.");
    const finish = () => {
      if (wasFooterVoice) {
        patchFooterVoiceCtaUi();
        return;
      }
      refreshVoiceUi();
    };
    if (opts?.tapFeedbackMs) {
      window.setTimeout(finish, opts.tapFeedbackMs);
      return;
    }
    finish();
  }

  function onCallClick(ev?: Event, scenario?: VoiceScenario, opts?: { tapFeedbackMs?: number }) {
    ev?.preventDefault();
    if (ev) {
      applyVoiceContextFromClick(ev.target);
    }
    if (scenario !== undefined) {
      activeVoiceScenario = scenario;
    }
    if (uiState === "connecting") return;
    if (uiState === "live") {
      endCall(opts);
    } else {
      void startCall(opts);
    }
  }

  window.addEventListener("keydown", onKeyDown);
  postBootRender = render;
  render();
}

void (async () => {
  // No token pre-warm here — WebRTC tokens are fetched on demand (user click only)
  // to avoid burning through ElevenLabs concurrent session limits before the user acts.

  // The prerendered page is visible (and clickable) before the fetches below
  // resolve, and a cold serverless start can take seconds. Capture early
  // "Get Started" clicks so the lead modal opens on mount instead of the click
  // silently doing nothing.
  const earlyLeadClick = (ev: Event) => {
    const el = ev.target as HTMLElement | null;
    const btn = el?.closest?.('[data-action="open-sign-up"]');
    if (!btn) return;
    ev.preventDefault();
    leadModalOpen = true;
    leadModalSourceProduct = btn.getAttribute("data-product") ?? "";
    syncLeadModalUrl(true);
  };
  document.addEventListener("click", earlyLeadClick, true);

  const computeIdleStatusText = () => {
    statusText = BROWSER_VOICE_ENABLED
      ? copy(
          "rt_status_idle",
          "Allow microphone access when prompted, then start the call.",
        )
      : telephonyOutbound.enabled
        ? copy(
            "rt_status_idle_call_me",
            "Enter your number. Hannah will call you. You're the buyer. Push back.",
          )
        : copy(
            "rt_status_idle_phone",
            "Call Hannah on your phone. You're the buyer. Push back.",
          );
  };

  // Honor "Get Started" clicks that happened before this bundle even loaded
  // (recorded by the tiny inline script in index.html <head>).
  const pendingLeadClick = (
    window as unknown as { __pendingLeadClick?: { product?: string } }
  ).__pendingLeadClick;
  if (pendingLeadClick) {
    leadModalOpen = true;
    leadModalSourceProduct = pendingLeadClick.product ?? "";
    syncLeadModalUrl(true);
  }

  // Mount immediately — don't gate interactivity on the fetches below (a cold
  // serverless start can take seconds). The built-in strings match the
  // published copy for the public pages, so the instant render is correct.
  computeIdleStatusText();
  mount();
  document.removeEventListener("click", earlyLeadClick, true);

  // Snapshot render-relevant config so the post-fetch step can tell if the
  // fetches changed anything the DOM shows. Compare *resolved* values, not raw
  // state: /api/telephony/status often returns the same phone number that is
  // already baked in via VITE_DEMO_PHONE_NUMBER, and rebuilding the DOM for a
  // no-op change resets LCP several seconds late. (outbound_api_url is only
  // used when placing a call — it never appears in the markup.)
  const phoneConfigSnapshot = () => {
    // telephonyOutbound is excluded: the retired call-me flow means the flag
    // no longer affects anything the DOM shows.
    const p = demoPhoneInfo();
    return JSON.stringify([p.display, p.tel, p.href]);
  };
  const phoneConfigBefore = phoneConfigSnapshot();

  // Apply late-arriving copy/config with one re-render, but never mid-interaction:
  // a re-render rebuilds the DOM and would wipe form input or close-feel the modal.
  await Promise.all([loadSiteCopy(), loadDemoPhoneFromHealth()]);
  // Check staleness before computeIdleStatusText(), which itself calls copy()
  // and would overwrite the recorded pre-fetch values.
  const bootFetchesChangedUi =
    renderedCopyIsStale() || phoneConfigSnapshot() !== phoneConfigBefore;
  if (uiState === "idle") computeIdleStatusText();
  const active = document.activeElement;
  const userIsBusy =
    leadModalOpen ||
    callMeModalOpen ||
    uiState !== "idle" ||
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement;
  // Skip the rebuild when the fetched copy matches what is already rendered —
  // rebuilding identical DOM pushed LCP out to the (cold) API round-trip.
  if (!userIsBusy && bootFetchesChangedUi) postBootRender?.();
})();
