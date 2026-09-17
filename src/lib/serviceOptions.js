import { badRequest } from './http.js';

/**
 * UC-C05 — service-specific questions, as data.
 *
 * Every question a service asks lives on the service in the database and is
 * edited in the admin panel: what it asks, how it is answered, what it adds to
 * the price and to the time the job takes. The apps only render what is here
 * and the server is the only thing that prices it, so a new question — or a new
 * service — never needs an app release.
 *
 * Choice lists are stored as parallel arrays (choices / choicePrices /
 * choiceMinutes), which keeps questions saved before per-choice
 * pricing existed readable exactly as they were.
 */
export const OPTION_TYPES = ['select', 'multiselect', 'number', 'boolean', 'text', 'textarea', 'time', 'date'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const nonNegative = (v, what, label) => {
  const n = Number(v || 0);
  if (!Number.isFinite(n) || n < 0) throw badRequest(`"${label}" has an invalid ${what}.`, 'INVALID_OPTION_VALUE');
  return n;
};
const listOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','));

export const slugKey = (v) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

/** One question as the admin panel sends it, checked and normalised for storage. */
export function normaliseOption(o, index) {
  const label = clean(o?.label, 80);
  const key = slugKey(o?.key || label);
  const type = OPTION_TYPES.includes(o?.type) ? o.type : 'text';
  const n = index + 1;

  if (!label) throw badRequest(`Question ${n} needs a label.`, 'OPTION_LABEL_REQUIRED');
  if (!key) throw badRequest(`Question ${n} needs a key.`, 'OPTION_KEY_REQUIRED');

  const hasChoices = type === 'select' || type === 'multiselect';
  const choices = hasChoices ? listOf(o.choices).map((c) => clean(c, 60)).filter(Boolean) : [];
  if (hasChoices && choices.length < 2) {
    throw badRequest(`"${label}" needs at least two choices.`, 'OPTION_CHOICES_REQUIRED');
  }
  if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) {
    throw badRequest(`"${label}" lists the same choice twice.`, 'OPTION_CHOICES_DUPLICATE');
  }
  // Per-choice extras line up with the choices by position; missing ones are 0 / blank.
  const aligned = (arr, fn) => choices.map((_, i) => fn((Array.isArray(arr) ? arr : [])[i]));
  const choicePrices = aligned(o.choicePrices, (v) => round2(nonNegative(v, 'choice price', label)));
  const choiceMinutes = aligned(o.choiceMinutes, (v) => Math.round(nonNegative(v, 'choice duration', label)));

  const pricePerUnit = round2(nonNegative(o.pricePerUnit, 'price', label));
  const minutesPerUnit = Math.round(nonNegative(o.minutesPerUnit, 'duration', label));

  let min = o.min === '' || o.min == null ? null : Number(o.min);
  let max = o.max === '' || o.max == null ? null : Number(o.max);
  if (type === 'number') {
    if (min != null && !Number.isFinite(min)) min = null;
    if (max != null && !Number.isFinite(max)) max = null;
    if (min != null && max != null && min > max) throw badRequest(`"${label}": the minimum is above the maximum.`, 'OPTION_RANGE_INVALID');
  } else {
    min = null;
    max = null;
  }

  // The default must be the shape the question asks for, or pricing would do arithmetic on a string.
  let defaultValue = o.defaultValue;
  if (type === 'number') {
    defaultValue = Number(defaultValue);
    if (!Number.isFinite(defaultValue)) defaultValue = min ?? 0;
    if (min != null) defaultValue = Math.max(min, defaultValue);
    if (max != null) defaultValue = Math.min(max, defaultValue);
  } else if (type === 'boolean') defaultValue = defaultValue === true || defaultValue === 'true';
  else if (type === 'select') defaultValue = choices.includes(defaultValue) ? defaultValue : o.required ? choices[0] : '';
  else if (type === 'multiselect') defaultValue = listOf(defaultValue).map((c) => clean(c, 60)).filter((c) => choices.includes(c));
  else defaultValue = defaultValue == null ? '' : clean(defaultValue, 300);

  return {
    key, label, type,
    help: clean(o.help, 160),
    placeholder: clean(o.placeholder, 80),
    choices, choicePrices, choiceMinutes,
    unit: clean(o.unit, 24),
    min, max,
    step: type === 'number' && Number(o.step) > 0 ? Number(o.step) : 1,
    required: Boolean(o.required),
    defaultValue,
    pricePerUnit,
    minutesPerUnit,
  };
}

/** A service's whole question list, with keys unique and a sensible cap. */
export function normaliseOptions(raw) {
  if (!Array.isArray(raw)) throw badRequest('Options must be a list.', 'INVALID_OPTIONS');
  if (raw.length > 15) throw badRequest('Fifteen questions per service is the most.', 'TOO_MANY_OPTIONS');
  const seen = new Set();
  return raw.map((o, i) => {
    const option = normaliseOption(o, i);
    if (seen.has(option.key)) throw badRequest(`Two questions share the key "${option.key}".`, 'DUPLICATE_OPTION_KEY');
    seen.add(option.key);
    return option;
  });
}

const isBlank = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * A customer's answers to one service's questions: validated, priced, timed,
 * and turned into the readable snapshot the booking keeps. Anything the
 * question does not ask for is ignored; anything required and missing is an
 * error that names the question.
 *
 * @returns {{ answers: object[], values: Record<string, unknown>, amount: number, minutes: number }}
 */
export function evaluateAnswers(service, raw = {}) {
  const out = { answers: [], values: {}, amount: 0, minutes: 0 };
  if (!service.optionsEnabled) return out;
  const given = raw && typeof raw === 'object' ? raw : {};

  for (const o of service.options || []) {
    let value = given[o.key];
    if (isBlank(value) && !isBlank(o.defaultValue) && o.type !== 'text' && o.type !== 'textarea') value = o.defaultValue;

    const where = `"${o.label}" for ${service.name}`;
    const invalid = (why) => badRequest(`${where} ${why}.`, 'INVALID_ANSWER', { option: o.key, service: service.code });

    if (isBlank(value) || (o.type === 'boolean' && value === undefined)) {
      if (o.required && o.type !== 'boolean') {
        throw badRequest(`Please answer ${where}.`, 'ANSWER_REQUIRED', { option: o.key, service: service.code });
      }
      if (o.type !== 'boolean') continue;
    }

    const choices = o.choices || [];
    let amount = 0;
    let minutes = 0;
    let display = '';

    switch (o.type) {
      case 'number': {
        const n = Number(value);
        if (!Number.isFinite(n)) throw invalid('must be a number');
        if (o.min != null && n < o.min) throw invalid(`must be at least ${o.min}`);
        if (o.max != null && n > o.max) throw invalid(`must be at most ${o.max}`);
        if (n < 0) throw invalid('cannot be negative');
        value = n;
        amount = (o.pricePerUnit || 0) * n;
        minutes = (o.minutesPerUnit || 0) * n;
        display = [n, o.unit].filter((x) => x !== '' && x != null).join(' ');
        break;
      }
      case 'boolean': {
        value = value === true || value === 'true' || value === 1;
        amount = value ? o.pricePerUnit || 0 : 0;
        minutes = value ? o.minutesPerUnit || 0 : 0;
        display = value ? 'Yes' : 'No';
        break;
      }
      case 'select': {
        const i = choices.indexOf(String(value));
        if (i < 0) throw invalid('is not one of the choices');
        value = choices[i];
        amount = o.choicePrices?.[i] || 0;
        minutes = o.choiceMinutes?.[i] || 0;
        display = choices[i];
        break;
      }
      case 'multiselect': {
        const picked = [...new Set((Array.isArray(value) ? value : [value]).map(String))];
        const idx = picked.map((p) => choices.indexOf(p));
        if (idx.some((i) => i < 0)) throw invalid('includes something that is not a choice');
        if (o.required && idx.length === 0) throw badRequest(`Please answer ${where}.`, 'ANSWER_REQUIRED', { option: o.key, service: service.code });
        const ordered = idx.sort((a, b) => a - b);
        value = ordered.map((i) => choices[i]);
        amount = ordered.reduce((s, i) => s + (o.choicePrices?.[i] || 0), 0) + (o.pricePerUnit || 0) * ordered.length;
        minutes = ordered.reduce((s, i) => s + (o.choiceMinutes?.[i] || 0), 0) + (o.minutesPerUnit || 0) * ordered.length;
        display = value.join(', ');
        break;
      }
      case 'time': {
        const v = String(value).trim();
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw invalid('must be a time like 18:30');
        value = v;
        display = v;
        break;
      }
      case 'date': {
        const v = String(value).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(`${v}T00:00:00`).getTime())) {
          throw invalid('must be a date');
        }
        value = v;
        display = v;
        break;
      }
      default: {
        const v = String(value).trim().slice(0, o.type === 'textarea' ? 1000 : 300);
        if (!v) {
          if (o.required) throw badRequest(`Please answer ${where}.`, 'ANSWER_REQUIRED', { option: o.key, service: service.code });
          continue;
        }
        value = v;
        display = v;
      }
    }

    // A "No" that costs nothing and was not required tells the helper nothing — leave it off the booking.
    if (o.type === 'boolean' && !value && !o.required) continue;

    out.values[o.key] = value;
    out.amount += amount;
    out.minutes += minutes;
    out.answers.push({
      key: o.key,
      label: o.label,
      type: o.type,
      value,
      display,
      amount: round2(amount),
      minutes: Math.round(minutes),
    });
  }

  out.amount = round2(out.amount);
  out.minutes = Math.round(out.minutes);
  return out;
}
