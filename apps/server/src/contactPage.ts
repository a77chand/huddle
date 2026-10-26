import { incident, row, type Millis, type Session } from '@huddle/core';

/**
 * The live page behind the link in an emergency contact's text. No app, no
 * JavaScript: plain HTML that refreshes itself. It shows exactly what the text
 * could (in encrypted huddles, a location only if the member allowed it) plus
 * who is responding, and an all-clear when it's over.
 */
export function contactPage(session: Session | null, memberId: string, now: Millis): { status: number; html: string } {
  if (!session || session.endedAt !== null) {
    return { status: 410, html: page('Huddle', '<h1>This huddle has ended</h1><p>There’s nothing more to show. If you’re still worried, call them directly.</p>', false) };
  }
  const m = session.members.find((x) => x.id === memberId);
  if (!m) return { status: 404, html: page('Huddle', '<h1>Link not found</h1>', false) };

  const clock = new Intl.DateTimeFormat('en-US', { timeZone: session.timeZone, hour: 'numeric', minute: '2-digit' });
  const name = esc(m.name);
  const inc = incident(session, memberId, now, { forContacts: true });
  const names = (ids: string[]) => ids.map((id) => esc(session.members.find((x) => x.id === id)?.name ?? 'a friend')).join(', ');

  if (!inc) {
    const r = row(session, m, now);
    const body =
      m.leftAt !== null
        ? `<div class="pill ok">No longer sharing</div><h1>${name} left the huddle</h1><p>They stopped sharing check-ins at ${clock.format(m.leftAt)}.</p>`
        : `<div class="pill ok">All clear</div><h1>${name} is okay</h1><p>Last check-in ${clock.format(r.lastCheckInAt)}. No action needed.</p>`;
    return { status: 200, html: page(`${m.name} — all clear`, body + footer(now, clock), true) };
  }

  const urgent = m.sos !== null;
  const list = (items: string[]) => `<ul>${items.map((x) => `<li>${linkify(esc(x))}</li>`).join('')}</ul>`;
  const responders = m.responders.length
    ? `<p class="resp">🙋 ${names(m.responders.map((r) => r.memberId))} ${m.responders.length > 1 ? 'are' : 'is'} responding.</p>`
    : '<p class="resp">Nobody in the group has said they’re on it yet.</p>';
  const body = `
    <div class="pill ${urgent ? 'sos' : 'warn'}">${urgent ? 'Asked for help' : 'Unreachable'}</div>
    <h1>${esc(inc.headline)}</h1>
    ${responders}
    <h2>What we know</h2>${list(inc.known.filter((k) => !/ is responding \(since /.test(k)))}
    ${inc.unknown.length ? `<h2>What we don’t know</h2>${list(inc.unknown)}` : ''}
    <h2>What you can do</h2>${list(inc.nextSteps.filter((s) => !/\btap "/i.test(s)))}
    ${footer(now, clock)}`;
  return { status: 200, html: page(`${m.name} — ${urgent ? 'asked for help' : 'unreachable'}`, body, true) };
}

function footer(now: Millis, clock: Intl.DateTimeFormat) {
  return `<p class="foot">Updated ${clock.format(now)} · refreshes every 30 s · Huddle is not an emergency service: if someone may be in danger, call your local emergency number.</p>`;
}

function page(title: string, body: string, refresh: boolean) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
${refresh ? '<meta http-equiv="refresh" content="30">' : ''}
<title>${esc(title)}</title>
<style>
:root{--bg:#f7f5fb;--card:#fff;--fg:#16121f;--muted:#6b6478;--ok:#14855b;--warn:#b86e00;--sos:#c8282e;--line:#e6e1ee}
@media (prefers-color-scheme:dark){:root{--bg:#0f0c17;--card:#1a1624;--fg:#f3f0fa;--muted:#a49db3;--ok:#3ccb8e;--warn:#f2a93b;--sos:#ff5a5f;--line:#2c263a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px}
h1{font-size:24px;margin:8px 0 12px}h2{font-size:15px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:24px 0 6px}
ul{margin:0;padding-left:20px}li{margin:6px 0}a{color:inherit}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px}
.pill.sos{background:color-mix(in srgb,var(--sos) 18%,transparent);color:var(--sos)}
.pill.warn{background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)}
.pill.ok{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
.resp{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.foot{color:var(--muted);font-size:13px;margin-top:32px}
</style></head><body><main>${body}</main></body></html>`;
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only the map links the server itself generates become clickable. */
function linkify(escaped: string) {
  return escaped.replace(/https:\/\/maps\.google\.com\/\?q=-?[\d.]+,-?[\d.]+/g, (u) => `<a href="${u}" rel="noopener noreferrer">open map</a>`);
}
