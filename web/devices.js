import { html, useState, useEffect, useRef } from "./vendor/preact-htm.js";

function DeviceRow({ d, here, ago, revoke }) {
  const [sure, setSure] = useState(false);
  const seen = d.lastSeen ? `seen ${ago(d.lastSeen)}` : "not seen yet";
  return html`<div class="set">
    <b>${d.name}${here && html` <span class="here">this device</span>`}</b>
    <p>Paired ${ago(d.created)}, ${seen}.${sure && here ? " Revoking this device logs it out." : ""}</p>
    <div class="ctl">${sure
      ? html`<div class="devact"><button class="btn" onClick=${() => setSure(false)}>Keep</button><button class="btn danger" onClick=${() => revoke(d)}>Revoke</button></div>`
      : html`<button class="btn" onClick=${() => setSure(true)}>Revoke…</button>`}</div>
  </div>`;
}

function Pairing({ pairing, onCopy, onNew, onClose, now }) {
  const left = new Date(pairing.expires) - now;
  const mins = Math.ceil(left / 60000);
  return html`<div class="pairbox">
    ${left > 0
      ? html`<div class="qr" dangerouslySetInnerHTML=${{ __html: pairing.svg }}></div>`
      : html`<div class="qr gone"><span>Expired</span></div>`}
    <div class="pairinfo">
      <p>Scan it in the atc app's setup screen. It lets one device into ${pairing.url}.</p>
      <p class="dim">${left > 0 ? `One use, ${mins} minute${mins === 1 ? "" : "s"} left.` : "This code is no longer valid."} On another computer run <code>atc login</code> or <code>atc peer add</code> with this text:</p>
      <code class="pairtext">${pairing.payload}</code>
      <div class="devact">
        ${left > 0 ? html`<button class="btn" onClick=${onCopy}>Copy text</button>` : html`<button class="btn primary" onClick=${onNew}>New code</button>`}
        <button class="btn" onClick=${onClose}>Done</button>
      </div>
    </div>
  </div>`;
}

export function DevicesSection({ api, app, copy, ago, openOut }) {
  const [st, setSt] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [showApp, setShowApp] = useState(false);
  const [note, setNote] = useState(null);
  const [now, setNow] = useState(Date.now());
  const known = useRef(null);
  const load = () => api("/api/devices").then((v) => { setSt(v); return v; }).catch((e) => setNote(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!pairing) return;
    const t = setInterval(async () => {
      setNow(Date.now());
      const v = await load();
      const fresh = v?.devices?.find((d) => !known.current?.has(d.id));
      if (fresh) { setPairing(null); setNote(`Paired ${fresh.name}.`); }
    }, 3000);
    return () => clearInterval(t);
  }, [pairing]);
  const start = async () => {
    setNote(null);
    known.current = new Set((st?.devices || []).map((d) => d.id));
    try { setPairing(await api("/api/pair", { method: "POST", body: {} })); setNow(Date.now()); } catch (e) { setNote(e.message); }
  };
  const revoke = async (d) => {
    try { await api(`/api/devices/${encodeURIComponent(d.id)}`, { method: "DELETE" }); setNote(`Revoked ${d.name}.`); load(); } catch (e) { setNote(e.message); }
  };
  const devices = st?.devices || [];
  return html`<section id="devices">
    <h2>Devices <span class="n">each with its own access</span></h2>
    <div class="set">
      <b>Pair a phone or computer</b>
      <p>Shows a code that lets one new device in, with no token to type.${st?.tailnet ? " Devices on your own tailnet get in without pairing, and revoking one here does not stop that." : ""}</p>
      <div class="ctl"><button class="btn" disabled=${!!pairing} onClick=${start}>Pair</button></div>
    </div>
    ${pairing && html`<${Pairing} pairing=${pairing} now=${now} onNew=${start} onClose=${() => setPairing(null)}
      onCopy=${() => { copy(pairing.payload); setNote("Copied."); }} />`}
    ${note && html`<p class="devnote" role="status">${note}</p>`}
    ${devices.map((d) => html`<${DeviceRow} key=${d.id} d=${d} here=${d.id === st.this} ago=${ago} revoke=${revoke} />`)}
    ${st && !devices.length && html`<div class="set"><p>No paired devices yet.</p></div>`}
    ${!app && st?.app && html`<div class="set">
      <b>Android app</b>
      <p>Scan with the phone's camera to download it, then install it and pair.</p>
      <div class="ctl"><button class="btn" aria-expanded=${showApp} onClick=${() => setShowApp(!showApp)}>${showApp ? "Hide" : "Show"} QR</button></div>
    </div>`}
    ${!app && showApp && st?.app && html`<div class="pairbox">
      <div class="qr" dangerouslySetInnerHTML=${{ __html: st.app.svg }}></div>
      <div class="pairinfo"><a href=${st.app.url} onClick=${(e) => { e.preventDefault(); openOut(st.app.url); }}>${st.app.url}</a></div>
    </div>`}
    ${app?.checklist && html`<div class="set">
      <b>This phone's setup</b>
      <p>Digital assistant, battery, links, microphone and notifications.</p>
      <div class="ctl"><button class="btn" onClick=${() => app.checklist()}>Open checklist</button></div>
    </div>`}
  </section>`;
}
