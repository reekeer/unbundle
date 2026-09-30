export interface ServiceFinding {
  kind: "auth" | "captcha" | "mini-app";
  name: string;
  file: string;
  line: number;
  detail: string;
}

const PATTERNS: Array<{ kind: ServiceFinding["kind"]; name: string; pattern: RegExp; detail: string }> = [
  { kind: "auth", name: "Telegram Login Widget", pattern: /\bTelegram\.Login\.(auth|init)\b|data-telegram-login\b|oauth\.telegram\.org/, detail: "login through Telegram" },
  { kind: "mini-app", name: "Telegram Mini App", pattern: /\bTelegram\.WebApp\b|\binitDataUnsafe\b|tgWebAppData|@telegram-apps\/sdk|@twa-dev\/sdk/, detail: "runs inside Telegram, reads initData" },
  { kind: "auth", name: "TON Connect", pattern: /\bTonConnect(UI)?\b|tonconnect-manifest\.json/, detail: "wallet login through TON Connect" },
  { kind: "auth", name: "Google Sign-In", pattern: /\bgoogle\.accounts\.(id|oauth2)\.|accounts\.google\.com\/(o\/oauth2|gsi)/, detail: "login through Google" },
  { kind: "auth", name: "Sign in with Apple", pattern: /\bAppleID\.auth\.|appleid\.apple\.com\/auth/, detail: "login through Apple" },
  { kind: "auth", name: "VK ID", pattern: /\bVKID\.|id\.vk\.com\/(authorize|auth)|oauth\.vk\.com\/authorize/, detail: "login through VK" },
  { kind: "auth", name: "Yandex ID", pattern: /\bYaAuthSuggest\b|oauth\.yandex\.(ru|com)\/authorize/, detail: "login through Yandex" },
  { kind: "auth", name: "GitHub OAuth", pattern: /github\.com\/login\/oauth\/authorize/, detail: "login through GitHub" },
  { kind: "auth", name: "Discord OAuth", pattern: /discord(app)?\.com\/(api\/)?oauth2\/authorize/, detail: "login through Discord" },
  { kind: "auth", name: "WebAuthn / passkeys", pattern: /navigator\.credentials\.(create|get)\b|PublicKeyCredential\b/, detail: "passkey login" },
  { kind: "auth", name: "Firebase Auth", pattern: /identitytoolkit\.googleapis\.com|\bsignInWithPopup\b|\bsignInWithEmailAndPassword\b/, detail: "Firebase Authentication" },
  { kind: "auth", name: "Supabase Auth", pattern: /\/auth\/v1\/(token|authorize|otp|signup)/, detail: "Supabase Auth" },
  { kind: "auth", name: "Clerk", pattern: /\bclerk\.(browser|accounts)\.|__clerk_db_jwt|\bClerkProvider\b/, detail: "Clerk" },
  { kind: "auth", name: "Auth0", pattern: /\.auth0\.com\/authorize|\bAuth0Provider\b|auth0-spa-js/, detail: "Auth0" },
  { kind: "auth", name: "NextAuth", pattern: /\/api\/auth\/(session|csrf|providers|callback|signin)/, detail: "NextAuth / Auth.js endpoints" },
  { kind: "captcha", name: "Cloudflare Turnstile", pattern: /challenges\.cloudflare\.com\/turnstile|\bturnstile\.(render|execute|reset)\b|cf-turnstile/, detail: "captcha" },
  { kind: "captcha", name: "reCAPTCHA", pattern: /\bgrecaptcha\.(execute|render|ready)\b|google\.com\/recaptcha\//, detail: "captcha" },
  { kind: "captcha", name: "hCaptcha", pattern: /\bhcaptcha\.(render|execute)\b|js\.hcaptcha\.com/, detail: "captcha" },
  { kind: "captcha", name: "Yandex SmartCaptcha", pattern: /smartcaptcha\.yandexcloud\.net|\bsmartCaptcha\.(render|execute)\b/, detail: "captcha" },
];

export function scanServices(file: string, code: string): ServiceFinding[] {
  const out: ServiceFinding[] = [];
  const seen = new Set<string>();
  const lines = code.split("\n");
  for (const { kind, name, pattern, detail } of PATTERNS) {
    if (!pattern.test(code)) continue;
    const line = lines.findIndex((text) => pattern.test(text));
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ kind, name, file, line: line + 1, detail });
  }
  return out;
}
