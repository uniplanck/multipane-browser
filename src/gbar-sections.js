// Grok bar section choices. Defaults are implicit; only a user's choices are saved.
const NAME_MAX = 100, MAX_CHOICES = 50;
const nameOk = name => typeof name === 'string' && name.length <= NAME_MAX && !!name.trim();
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function clean(value) {
  const choices = new Map();
  if (plain(value)) for (const [key, open] of Object.entries(value)) {
    if (!nameOk(key) || typeof open !== 'boolean') continue;
    const name = key.trim();
    if (choices.has(name) || choices.size < MAX_CHOICES) choices.set(name, open);
  }
  return Object.fromEntries(choices);
}
function valid(value) {
  if (!plain(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= MAX_CHOICES && keys.every(k => typeof k === 'string' && nameOk(k) && k === k.trim()
    && Object.prototype.propertyIsEnumerable.call(value, k) && typeof value[k] === 'boolean');
}
function open(choices, name) {
  const key = typeof name === 'string' ? name.trim() : '';
  return plain(choices) && Object.hasOwn(choices, key) && typeof choices[key] === 'boolean' ? choices[key] : key !== '待機';
}
function toggle(choices, name) {
  if (!nameOk(name)) return clean(choices);
  const key = name.trim(), next = new Map(Object.entries(clean(choices))), value = !open(choices, key);
  next.delete(key);
  if (next.size >= MAX_CHOICES) next.delete(next.keys().next().value);
  next.set(key, value);
  return Object.fromEntries(next);
}
module.exports = { NAME_MAX, MAX_CHOICES, nameOk, clean, valid, open, toggle };
