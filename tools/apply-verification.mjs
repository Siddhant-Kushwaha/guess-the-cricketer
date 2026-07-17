#!/usr/bin/env node
// Consumes the full-player-verification workflow output, diffs against current data.js
// field-by-field, prints a correction report, and rebuilds data.js from verified records.
// Usage: node tools/apply-verification.mjs <workflow-output.json>
import fs from 'fs';

const OUT = process.argv[2];
if (!OUT) { console.error('pass the workflow output json path'); process.exit(1); }

// --- load current data ---
const src = fs.readFileSync('data.js', 'utf8');
const w = {};
new Function('window', src).call(w, w);
const cur = {}; w.CRICKETERS.forEach(p => { cur[p.name] = p; });

// --- load verified records ---
let raw = fs.readFileSync(OUT, 'utf8');
let data = JSON.parse(raw.slice(raw.indexOf('{')));
let res = data.result || data;
if (typeof res === 'string') res = JSON.parse(res);
const verified = res.records || res;

// Agents kept repeated franchises (e.g. ["CSK","RPS","CSK"]) to pin the current team.
// Dedupe to unique franchises, keeping first-seen order but forcing the CURRENT (original
// last element) to remain last, so display is clean and green=current-team stays correct.
function dedupeIpls(arr) {
  if (!arr || !arr.length) return [];
  const current = arr[arr.length - 1];
  const seen = {}, out = [];
  for (const t of arr) { if (!seen[t]) { seen[t] = 1; out.push(t); } }
  return out.filter(t => t !== current).concat([current]);
}
verified.forEach(v => { v.ipls = dedupeIpls(v.ipls); });

const FIELDS = ['country', 'role', 'bat', 'bowl', 'debut', 'wc'];
const counts = { country: 0, role: 0, bat: 0, bowl: 0, debut: 0, wc: 0, ipls_current: 0, ipls_full: 0 };
const changes = [];
const notFound = [];

for (const v of verified) {
  const c = cur[v.name];
  if (!c) { notFound.push(v.name); continue; }
  for (const f of FIELDS) {
    if (String(c[f]) !== String(v[f])) { counts[f]++; changes.push(`${v.name}: ${f}  ${c[f]} -> ${v[f]}`); }
  }
  const curLast = (c.ipls && c.ipls.length) ? c.ipls[c.ipls.length - 1] : '—';
  const vLast = (v.ipls && v.ipls.length) ? v.ipls[v.ipls.length - 1] : '—';
  if (curLast !== vLast) { counts.ipls_current++; changes.push(`${v.name}: current-team  ${curLast} -> ${vLast}`); }
  if (JSON.stringify(c.ipls) !== JSON.stringify(v.ipls)) counts.ipls_full++;
}

console.log('=== CORRECTION REPORT ===');
console.log('verified records:', verified.length, '| matched to current:', verified.length - notFound.length);
if (notFound.length) console.log('NAME MISMATCH (not in current data):', notFound.join(', '));
console.log('\nCorrections by field:');
for (const k of Object.keys(counts)) console.log(`  ${k.padEnd(14)}: ${counts[k]}`);
console.log(`  TOTAL field-changes: ${Object.values(counts).reduce((a, b) => a + b, 0)}`);
console.log('\nAll changes:');
changes.forEach(c => console.log('  ' + c));

// --- rebuild data.js from verified (fall back to current for any name only in current) ---
const byName = {}; verified.forEach(v => { byName[v.name] = v; });
const merged = w.CRICKETERS.map(c => {
  const v = byName[c.name];
  if (!v) return c; // keep unverified as-is
  return { name: c.name, country: v.country, role: v.role, bat: v.bat, bowl: v.bowl,
    debut: v.debut, ipls: v.ipls, wc: v.wc, ...(c.legend ? { legend: true } : {}), ...(c.answerable === false ? { answerable: false } : {}) };
});

const order = [];
merged.forEach(p => { if (!order.includes(p.country)) order.push(p.country); });
const row = p => {
  const ipls = '[' + p.ipls.map(t => `"${t}"`).join(',') + ']';
  const leg = p.legend ? ', legend: true' : '';
  const ans = p.answerable === false ? ', answerable: false' : '';
  return `    { name: "${p.name.replace(/"/g, '\\"')}", country: "${p.country}", role: "${p.role}", bat: "${p.bat}", bowl: "${p.bowl}", debut: ${p.debut}, ipls: ${ipls}, wc: "${p.wc}"${leg}${ans} },`;
};
let L = [`/* Guess the Cricketer - player database. Facts verified against ESPNcricinfo + web.
 * role = ESPNcricinfo Playing Role (verbatim). ipls = all IPL franchises chronological (last = current team).
 * wc = WON | SQUAD | NEVER. legend = all-time great (Legends mode). Codes incl. defunct KTK PWI RPS GL DECCAN.
 */
(function (root) {
  var C = [`];
for (const co of order) { L.push(`    // ---------- ${co.toUpperCase()} ----------`); merged.filter(p => p.country === co).forEach(p => L.push(row(p))); }
for (let i = L.length - 1; i >= 0; i--) { if (L[i].trim().startsWith('{')) { L[i] = L[i].replace(/,$/, ''); break; } }
L.push('  ];', '  root.CRICKETERS = C;', '})(typeof window !== "undefined" ? window : this);');
fs.writeFileSync('data.js', L.join('\n') + '\n');
console.log('\ndata.js rebuilt from verified records:', merged.length, 'players.');
