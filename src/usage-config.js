// AI使用量表示の設定 (右上のゲージ): settings.usageShow (表示するか) / usageV2 (一度だけの移行が済んだ印) / usageProv (プロバイダ別の設定).
// Pure (no electron, no fs) so plain Node tests cover it (test/usage-config.test.js); state-schema.js uses clean() / valid() on panes.json.
// usageProv: { codex: { on, web, local }, claude: { on, web, local }, kimi: { on, web }, antigravity: { on }, grok: { on } }
//   on    = the gauge is listed (when usageShow is on)
//   web   = signed in through the app's login window (its own persistent partition; usage-web.js). Set by main after a read that was not a
//           sign-in page, cleared by 切断
//   local = explicit opt-in to the old local sign-ins: Claude Code's Keychain item / Codex CLI's ~/.codex/auth.json (ai-usage.js). Never
//           on by default; the one-time migration turns it on (visibly, as a checked menu item) for an existing install so its gauges stay
// Nothing is read or fetched for a provider unless usageShow and its own `on` are true (source() = 'off').
const PROVIDERS = ['codex', 'claude', 'kimi', 'antigravity', 'grok'];        // the bar's order, left to right
const FIELDS = { codex: ['on', 'web', 'local'], claude: ['on', 'web', 'local'], kimi: ['on', 'web'], antigravity: ['on'], grok: ['on'] };
const DEFAULT_ON = { codex: true, claude: true, kimi: false, antigravity: false, grok: true };   // the three gauges the bar always had
const NAMES = { codex: 'ChatGPT / Codex', claude: 'Claude', kimi: 'Kimi', antigravity: 'Google Antigravity', grok: 'Grok' };
const WEB = ['codex', 'claude', 'kimi'];          // read from the provider's own usage page after a sign-in in the app's login window
const LOCAL = ['codex', 'claude'];                // the opt-in local sign-ins (ai-usage.js)

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const fresh = k => Object.fromEntries(FIELDS[k].map(f => [f, f === 'on' ? DEFAULT_ON[k] : false]));
const defaults = () => Object.fromEntries(PROVIDERS.map(k => [k, fresh(k)]));

// anything -> { prov: every provider with exactly its fields (booleans; missing / wrong -> the default), same: raw was already exactly that }
function clean(raw) {
  const src = isObj(raw) ? raw : {};
  const prov = Object.fromEntries(PROVIDERS.map(k => {
    const r = own(src, k) && isObj(src[k]) ? src[k] : {}, d = fresh(k);
    return [k, Object.fromEntries(FIELDS[k].map(f => [f, typeof r[f] === 'boolean' ? r[f] : d[f]]))];
  }));
  return { prov, same: valid(raw) };
}
// exactly what clean() keeps: every provider, its fields only, booleans only
function valid(p) {
  if (!isObj(p)) return false;
  const ks = Object.keys(p);
  return ks.length === PROVIDERS.length && PROVIDERS.every(k => own(p, k) && isObj(p[k])
    && Object.keys(p[k]).length === FIELDS[k].length && FIELDS[k].every(f => typeof p[k][f] === 'boolean'));
}
const provOf = settings => valid(settings && settings.usageProv) ? settings.usageProv : clean(settings && settings.usageProv).prov;

// is this an install that was used before the redesign? The panes.json file existed (also an unreadable one: recovery keeps it), or it already
// holds a usage setting of the old gauges (usageBase = the Grok gauge's daily baseline, usageMargin = its popover's margin)
function existingInstall({ fileExisted, settings } = {}) {
  const s = isObj(settings) ? settings : {};
  return fileExisted === true || isObj(s.usageBase) || typeof s.usageMargin === 'number';
}
// once (usageV2): a new install -> usageShow off (no gauge, nothing read); an existing one -> on, with the local sign-ins it used so far
// (Keychain / auth.json) as checked opt-ins, so the same gauges show as before. A second run does nothing. Returns a new object.
function migrate(settings, { existing = false } = {}) {
  const s = isObj(settings) ? settings : {};
  if (s.usageV2 === true) return { settings: s, changed: false };
  const prov = clean(s.usageProv).prov;
  if (existing) LOCAL.forEach(k => { prov[k].local = true; });
  return { settings: { ...s, usageShow: typeof s.usageShow === 'boolean' ? s.usageShow : !!existing, usageProv: prov, usageV2: true }, changed: true };
}

// where a gauge's numbers come from right now:
//   'off'   = not shown (usageShow off / provider off): nothing is read
//   'local' = the opt-in local sign-in (ai-usage.js), 'web' = the app's own login (usage-web.js), 'none' = neither yet (the gauge offers 接続)
//   'grok'  = the grok.com panes' session (as before), 'info' = no web usage page (Antigravity): a note and a link only
function source(settings, k) {
  if (!isObj(settings) || settings.usageShow !== true || !PROVIDERS.includes(k)) return 'off';
  const p = provOf(settings)[k];
  if (!p.on) return 'off';
  if (k === 'grok') return 'grok';
  if (k === 'antigravity') return 'info';
  if (p.local) return 'local';
  return p.web ? 'web' : 'none';
}
// what the bar gets with every state: { show, list: [{ id, src }] } (the shown gauges, in bar order)
function view(settings) {
  const show = isObj(settings) && settings.usageShow === true;
  return { show, list: show ? PROVIDERS.map(id => ({ id, src: source(settings, id) })).filter(x => x.src !== 'off') : [] };
}
// a change from the settings menu -> a new settings object (prov cleaned first); unknown provider / field: unchanged
function set(settings, k, field, value) {
  const s = isObj(settings) ? settings : {};
  if (!PROVIDERS.includes(k) || !FIELDS[k].includes(field) || typeof value !== 'boolean') return s;
  const prov = clean(s.usageProv).prov;
  prov[k] = { ...prov[k], [field]: value };
  return { ...s, usageProv: prov };
}

module.exports = { PROVIDERS, FIELDS, DEFAULT_ON, NAMES, WEB, LOCAL, defaults, clean, valid, existingInstall, migrate, source, view, set };
