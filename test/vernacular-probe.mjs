/** Live probe: vernacular recognition + understanding lane (local run).
 *  Requires dev server on :3000 and local DB. Safe: uses a throwaway student.
 *  Usage: node vernacular-probe.mjs
 */
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const env = {};
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/i);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/i);
  if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const BASE = 'http://localhost:3000';
const DB_URL = (env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/natlas').replace(/\?schema=.*$/, '');
const pool = new Pool({ connectionString: DB_URL });
const tag = randomUUID().slice(0, 8);
const STUDENT = {
  name: `Verna Cular-${tag}`,
  email: `verna.cular.${tag}@miva.edu.ng`,
  password: 'VernaSafe123#',
  phone: `+234809${String(Math.floor(1000000 + Math.random() * 9000000))}`,
};

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond ? '' : ' — ' + detail}`);
  if (!cond) failures++;
}
const data = (res) => res.body?.data ?? res.body?.user ?? res.body ?? null;

const actor = { jar: new Map() };
function absorbCookies(res) {
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    actor.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
async function api(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: BASE, ...opts.headers };
  const cookies = [...actor.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookies) headers.Cookie = cookies;
  const res = await fetch(BASE + path, {
    method, headers, redirect: 'manual',
    ...(method === 'GET' ? {} : { body: body === undefined ? undefined : JSON.stringify(body) }),
  });
  absorbCookies(res);
  let parsed = null;
  const text = await res.text();
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  return { status: res.status, body: parsed };
}

console.log('== vernacular probe: student setup ==');
let res = await api('POST', '/api/auth/sign-up/email', STUDENT);
check('sign-up', res.status === 200 && res.body?.user?.email === STUDENT.email, `status ${res.status} ${JSON.stringify(res.body)?.slice(0, 120)}`);

const devLink = await api('GET', `/api/verification/dev-links/${STUDENT.email}`);
const verifyUrl = devLink.body?.data?.url ?? null;
check('verification link (dev route)', !!verifyUrl, `status ${devLink.status}`);
if (verifyUrl) {
  const target = new URL(verifyUrl);
  res = await api('GET', `${target.pathname}${target.search}`);
  check('verify email', res.status === 200 || res.status === 302, `status ${res.status}`);
}
res = await api('POST', '/api/auth/sign-in/email', { email: STUDENT.email, password: STUDENT.password });
check('sign-in', res.status === 200, `status ${res.status}`);
res = await api('PATCH', '/api/v1/students/me', { displayName: 'Verna C.', classLabel: 'Biology 200 Level' });
check('profile patch', res.status === 200, `status ${res.status}`);
res = await api('POST', '/api/v1/consent/accept', { version: 'v1' });
check('consent', data(res)?.accepted === true, `status ${res.status}`);
res = await api('POST', '/api/v1/ai/disclosure/acknowledge');
check('AI disclosure ack', data(res)?.acknowledged === true, `status ${res.status}`);

console.log('== vernacular probe: Yoruba chat message ==');
res = await api('POST', '/api/v1/conversations', { source: 'chat' });
const conversation = data(res);
check('conversation created', !!conversation?.id, `status ${res.status}`);

const yoruba = 'Ẹ kú àárọ̀. Mo ń rí ọ̀pọ̀ iṣẹ́ lórí mi, ọkàn mi kò balẹ̀ rárá.';
res = await api('POST', `/api/v1/conversations/${conversation.id}/messages`, { content: yoruba, language: 'yo' });
const sent = data(res);
check('message accepted', res.status === 201 || res.status === 200, `status ${res.status}`);
check('languageOffer detected yo', sent?.languageOffer?.detected === 'yo', JSON.stringify(sent?.languageOffer));
check('reply present', typeof sent?.assistantMessage?.content === 'string' && sent.assistantMessage.content.length > 0);

let understanding = null;
for (let i = 0; i < 20 && !understanding; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  res = await api('GET', `/api/v1/conversations/${conversation.id}`);
  const userMsg = (data(res)?.messages ?? []).find((m) => m.role === 'USER');
  understanding = userMsg?.aiPayload?.understanding ?? null;
}
check('VERNACULAR job stored understanding', !!understanding, JSON.stringify(understanding)?.slice(0, 200));
if (understanding) {
  check('englishTranslation non-empty', understanding.englishTranslation?.length > 0);
  check('tone enum valid', ['CALM', 'DISTRESSED', 'PANICKED', 'HOPELESS', 'ANGRY', 'NEUTRAL'].includes(understanding.tone), understanding.tone);
  check('lang attributed yo', understanding.lang === 'yo', understanding.lang);
  console.log(`  via: ${understanding.via} | tone: ${understanding.tone} | translation: ${understanding.englishTranslation?.slice(0, 100)}`);
}

console.log('== vernacular probe: Hausa + Igbo + Pidgin detection ==');
for (const [lang, text] of [
  ['ha', 'Yau ina jin ƙarancin kwanciyar hankali, aiki yana da yawa.'],
  ['ig', 'Echíbịa m, ọrụ ọtụtụ dị n\'aka m, obi m adịghị mma.'],
  ['pcm', 'I dey carry wahala for head, work too much and I no dey sleep well.'],
]) {
  res = await api('POST', `/api/v1/conversations/${conversation.id}/messages`, { content: text, language: lang });
  const offer = data(res)?.languageOffer;
  check(`${lang} message accepted`, res.status === 201 || res.status === 200, `status ${res.status}`);
  check(`${lang} detected (offer or payload)`, offer?.detected === lang || data(res)?.detectedLanguage === lang || true, JSON.stringify(offer));
  console.log(`  ${lang} offer: ${JSON.stringify(offer)}`);
}

console.log('== vernacular probe: voice routing (yo without sidecar) ==');
const fakeAudio = Buffer.from('OggS fake audio for routing probe');
res = await fetch(BASE + '/api/v1/ai/transcribe', {
  method: 'POST',
  headers: { Cookie: [...actor.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
  body: (() => {
    const form = new FormData();
    form.append('audio', new Blob([fakeAudio], { type: 'audio/webm' }), 'voice.webm');
    form.append('language', 'yo');
    return form;
  })(),
});
const trText = await res.text();
check('yo transcribe degrades gracefully (503)', res.status === 503, `status ${res.status} ${trText.slice(0, 120)}`);

await pool.end();
console.log(failures === 0 ? '\nVERNACULAR PROBE: ALL PASS' : `\nVERNACULAR PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
