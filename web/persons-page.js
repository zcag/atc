import { html, useState, useEffect, useRef } from "./vendor/preact-htm.js";
import { speakers, personLangs, langName, voiceName, roomName } from "./persons.js";
import { usePortrait } from "./portrait.js";

export const ROOMS = "/app/personas/_rooms/";
const WORDS = { orb: "A glass sphere that swirls with the voices" };
const KINDS = { rig: "A drawn portrait that looks, nods and talks", illustration: "A drawn portrait", footage: "A filmed portrait" };
const takesRoom = (look, c) => look.kinds[c] === "rig";
const title = (t) => t[0].toUpperCase() + t.slice(1);

/** Hears a voice before it is picked: the voice service renders a sample once and keeps it. */
export function useSample(voices, setNote) {
  const [playing, setPlaying] = useState(null);
  const audio = useRef(null);
  useEffect(() => () => audio.current?.pause(), []);
  const stop = () => { audio.current?.pause(); audio.current = null; setPlaying(null); };
  const play = async (lang, v) => {
    const k = `${lang}:${v}`;
    if (playing === k) return stop();
    stop();
    setPlaying(k);
    setNote("");
    try {
      const r = await fetch(`/api/call/voices/sample?${new URLSearchParams({ lang, voice: v, text: voices[lang].sample })}`);
      if (!r.ok) throw new Error(r.status === 409 ? "a call is on, and this sample renders after it" : "the sample did not come");
      const a = new Audio(URL.createObjectURL(await r.blob()));
      audio.current = a;
      a.onended = () => setPlaying((p) => (p === k ? null : p));
      await a.play();
    } catch (e) {
      setPlaying((p) => (p === k ? null : p));
      setNote(`Can't play ${voiceName(v)}: ${e.message}.`);
    }
  };
  return [playing, play];
}

function Portrait({ look, character, background }) {
  const url = usePortrait(character, background, look.revs?.[character], look.kinds[character]);
  if (character === "orb") return html`<span class="face orbface" aria-hidden="true"><i></i></span>`;
  return html`<span class="face ${url ? "" : "waiting"}" aria-hidden="true">${url && html`<img src=${url} alt="" />`}</span>`;
}

const describe = (p) => [p.character, p.background && `${roomName(p.background)} background`].filter(Boolean).join(", ");

/** One language's person, big, with everyone who can speak it underneath to swap to. */
function LanguageSlot({ look, lang, setNote }) {
  const { doc } = look;
  const all = speakers(doc, lang);
  const on = doc.persons.find((p) => p.id === doc.langs[lang]);
  const use = async (p) => {
    try { await look.choose(lang, p.id); setNote(`${p.name} speaks ${langName(lang)} from the next reply.`); }
    catch (e) { setNote(`Couldn't switch to ${p.name}: ${e.message}`); }
  };
  return html`<div class="slot">
    <div class="slotface">
      ${on ? html`<${Portrait} look=${look} character=${on.character} background=${on.background} />` : html`<span class="face empty" aria-hidden="true"></span>`}
    </div>
    <div class="slotside">
    <div class="slotcap"><span>In ${langName(lang)}</span><b>${on?.name || "Nobody yet"}</b>${on && html`<span class="d">${voiceName(on.voices[lang] || "")}</span>`}</div>
    ${all.length > 1 && html`<div class="swap" role="radiogroup" aria-label=${`The assistant in ${langName(lang)}`}>
      ${all.map((p) => html`<button role="radio" aria-checked=${p.id === on?.id} title=${p.name} onClick=${() => use(p)}>
        <${Portrait} look=${look} character=${p.character} background=${p.background} /><span>${p.name}</span></button>`)}
    </div>`}
    ${all.length === 0 && html`<p class="sub">Nobody has a ${langName(lang)} voice yet. Give someone one to pick them here.</p>`}
    </div>
  </div>`;
}

function PersonCard({ look, p, agents }) {
  const langs = Object.keys(p.voices || {}).filter((l) => look.doc.langs[l] === p.id);
  const on = agents.filter((a) => a.person === p.id);
  return html`<a class="personcard" href=${`#/settings/persons/${encodeURIComponent(p.id)}`}>
    <${Portrait} look=${look} character=${p.character} background=${p.background} />
    <b>${p.name}</b>
    <span class="d">${describe(p)}</span>
    ${(langs.length > 0 || on.length > 0) && html`<span class="tags">
      ${langs.map((l) => html`<em>Assistant in ${langName(l)}</em>`)}
      ${on.map((a) => html`<em>${a.title || a.name}</em>`)}
    </span>`}
  </a>`;
}

/** Agents you can talk to on a call: who each one is there, and its own background if it wants one over theirs. */
function AgentPersons({ api, look, agents, rooms, reload, setNote }) {
  const talking = agents.filter((a) => a.talk);
  const { doc } = look;
  const set = async (a, change) => {
    const name = a.title || a.name;
    try {
      await api(`/api/agents/${encodeURIComponent(a.name)}/person`, { method: "POST", body: { person: a.person || "", background: a.background || "", ...change } });
      setNote(`${name} looks that way from the next time you talk to it.`);
      reload();
    } catch (e) { setNote(`Couldn't change ${name}: ${e.message}`); }
  };
  return html`<section>
    <h2>Agents on a call</h2>
    ${talking.length === 0 && html`<p class="sub">No agent can talk on a call yet. Add <code>"talk": true</code> to an agent's agent.json and it appears here.</p>`}
    ${talking.map((a) => {
      const name = a.title || a.name;
      const own = doc.persons.find((x) => x.id === a.person);
      const seen = own || look.person || doc.persons.find((x) => Object.values(doc.langs).includes(x.id));
      return html`<div class="agrow" key=${a.name}>
        ${seen ? html`<${Portrait} look=${look} character=${seen.character} background=${a.background || seen.background} />` : html`<span class="face empty" aria-hidden="true"></span>`}
        <div class="agmain">
          <b>${name}</b>
          <label><span>Person</span><select aria-label=${`Who ${name} is on a call`} value=${a.person || ""} onChange=${(e) => set(a, { person: e.target.value })}>
            <option value="">Same as the assistant</option>
            ${doc.persons.map((x) => html`<option value=${x.id}>${x.name}</option>`)}
          </select></label>
          ${seen && !takesRoom(look, seen.character) ? html`<p class="sub">${title(seen.character)} draws its own surroundings.</p>` : html`
            <div class="swap" role="radiogroup" aria-label=${`Background for ${name}`}>
              <button role="radio" aria-checked=${!a.background} onClick=${() => set(a, { background: "" })}>
                ${seen ? html`<${Portrait} look=${look} character=${seen.character} background=${seen.background} />` : html`<span class="face empty"></span>`}<span>Their own</span></button>
              ${rooms.map((f) => html`<button role="radio" key=${f} aria-checked=${a.background === f} onClick=${() => set(a, { background: f })}>
                <span class="face"><img src=${ROOMS + f} alt="" loading="lazy" /></span><span>${title(roomName(f))}</span></button>`)}
            </div>`}
        </div>
      </div>`; })}
  </section>`;
}

function Gallery({ api, look, agents, rooms, reloadAgents, voices }) {
  const [note, setNote] = useState("");
  const { doc } = look;
  const langs = personLangs(voices, doc);
  return html`
    <h1>Persons</h1>
    <p class="capintro">Who you hear and see on a call: a name, a character, a background and a voice for each language.</p>
    ${doc.persons.length === 0 ? html`
      <a class="personcard new first" href="#/settings/persons/new"><span class="face plus" aria-hidden="true"></span><b>Make the first person</b><span class="d">The assistant becomes them in every language they speak.</span></a>`
    : html`
      <section>
        <h2>The assistant</h2>
        <div class="slots">${langs.map((l) => html`<${LanguageSlot} key=${l} look=${look} lang=${l} setNote=${setNote} />`)}</div>
        ${note && html`<p class="sub" role="status">${note}</p>`}
      </section>
      <section>
        <h2>Everyone <span class="n">${doc.persons.length}</span></h2>
        <div class="gallery">
          ${doc.persons.map((p) => html`<${PersonCard} key=${p.id} look=${look} p=${p} agents=${agents} />`)}
          <a class="personcard new" href="#/settings/persons/new"><span class="face plus" aria-hidden="true"></span><b>New person</b></a>
        </div>
      </section>
      <${AgentPersons} api=${api} look=${look} agents=${agents} rooms=${rooms} reload=${reloadAgents} setNote=${setNote} />
      ${note && html`<p class="sub" role="status">${note}</p>`}`}`;
}

function Tile({ on, label, onClick, children }) {
  return html`<button type="button" class="tile" role="radio" aria-checked=${on} onClick=${onClick}>${children}<span>${label}</span></button>`;
}

function Editor({ api, look, voices, rooms, reloadRooms, draft, Preview, onDone }) {
  const [p, setP] = useState(draft);
  const [note, setNote] = useState("");
  const [sure, setSure] = useState(false);
  const [playing, play] = useSample(voices, setNote);
  const set = (o) => setP((old) => ({ ...old, ...o }));
  const save = async (e) => {
    e.preventDefault();
    try { look.keep(await api("/api/call/persons", { method: "POST", body: p })); onDone(); }
    catch (err) { setNote(`Couldn't save: ${err.message}`); }
  };
  const remove = async () => {
    if (!sure) return setSure(true);
    try { look.keep(await api(`/api/call/persons/${encodeURIComponent(p.id)}`, { method: "DELETE" })); onDone(); }
    catch (err) { setNote(`Couldn't delete: ${err.message}`); }
  };
  const addRoom = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const body = new FormData();
    body.append("file", file);
    setNote(`Adding ${file.name}`);
    try {
      const r = await fetch("/api/call/backgrounds", { method: "POST", body });
      if (!r.ok) throw new Error((await r.text()).trim());
      const { file: added } = await r.json();
      await reloadRooms();
      set({ background: added });
      setNote("");
    } catch (err) { setNote(`Couldn't add it: ${err.message}`); }
  };
  const dropRoom = async (f) => {
    try {
      await api(`/api/call/backgrounds/${encodeURIComponent(f)}`, { method: "DELETE" });
      if (p.background === f) set({ background: "" });
      await reloadRooms();
    } catch (err) { setNote(`Couldn't remove ${roomName(f)}: ${err.message}`); }
  };
  const canRoom = takesRoom(look, p.character);
  const langs = personLangs(voices, { persons: [p] });
  return html`<form class="peditor" onSubmit=${save}>
    <div class="pvcol">
      <div class="pvframe"><${Preview} character=${p.character} background=${canRoom ? p.background : ""} /></div>
    </div>
    <div class="pfields">
      <a class="backto" href="#/settings/persons">Persons</a>
      <label class="pname"><span>Name</span><input value=${p.name} maxlength="40" required placeholder="What they are called" onInput=${(e) => set({ name: e.target.value })} /></label>
      <fieldset>
        <legend>Character</legend>
        <div class="picktiles" role="radiogroup" aria-label="Character">
          ${look.names.map((n) => html`<${Tile} key=${n} on=${p.character === n} label=${title(n)} onClick=${() => set({ character: n })}>
            <${Portrait} look=${look} character=${n} /><//>`)}
        </div>
        <p class="sub">${WORDS[p.character] || KINDS[look.kinds[p.character]] || ""}</p>
      </fieldset>
      <fieldset disabled=${!canRoom}>
        <legend>Background</legend>
        ${canRoom ? html`<div class="picktiles" role="radiogroup" aria-label="Background">
          <${Tile} on=${!p.background} label="Their own room" onClick=${() => set({ background: "" })}><${Portrait} look=${look} character=${p.character} /><//>
          ${rooms.map((f) => html`<div class="roomtile" key=${f}>
            <${Tile} on=${p.background === f} label=${title(roomName(f))} onClick=${() => set({ background: f })}><span class="face"><img src=${ROOMS + f} alt="" loading="lazy" /></span><//>
            <button type="button" class="tiledrop" aria-label=${`Remove ${roomName(f)}`} title=${`Remove ${roomName(f)}`} onClick=${() => dropRoom(f)}>×</button>
          </div>`)}
          <label class="tile add"><span class="face plus" aria-hidden="true"></span><span>Add an image</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange=${addRoom} /></label>
        </div>` : html`<p class="sub">The orb draws its own surroundings.</p>`}
      </fieldset>
      ${langs.map((lang) => { const cur = p.voices?.[lang] || "", all = voices?.[lang]?.voices || (cur ? [cur] : []); return html`<fieldset key=${lang}>
        <legend>${langName(lang)} voice</legend>
        <div class="vlist" role="radiogroup" aria-label=${`${langName(lang)} voice`}>
          <div class="vrow ${cur ? "" : "on"}"><button type="button" role="radio" aria-checked=${!cur} onClick=${() => set({ voices: { ...p.voices, [lang]: "" } })}>Doesn't speak ${langName(lang)}</button></div>
          ${all.map((v) => { const k = `${lang}:${v}`; return html`<div class="vrow ${cur === v ? "on" : ""}" key=${v}>
            <button type="button" role="radio" aria-checked=${cur === v} onClick=${() => set({ voices: { ...p.voices, [lang]: v } })}>${voiceName(v)}</button>
            ${voices && html`<button type="button" class="kb" aria-pressed=${playing === k} aria-label=${`${playing === k ? "Stop" : "Play"} ${voiceName(v)}`} onClick=${() => play(lang, v)}>${playing === k ? "Stop" : "Play"}</button>`}
          </div>`; })}
        </div>
      </fieldset>`; })}
      ${!voices && html`<p class="sub">The voices are not reachable, so only saved ones show.</p>`}
      ${note && html`<p class="sub" role="status">${note}</p>`}
      <div class="pactions">
        <button class="btn primary" type="submit">${p.id ? "Save changes" : "Add person"}</button>
        <a class="btn" href="#/settings/persons">Cancel</a>
        ${p.id && html`<button class="btn danger" type="button" onClick=${remove}>${sure ? `Delete ${p.name} for good` : "Delete"}</button>`}
      </div>
    </div>
  </form>`;
}

/** Settings' Persons page: `sub` empty is the gallery, "new" or a person's id is the editor. */
export function PersonsPage({ api, look, sub, Preview, go }) {
  const [voices, setVoices] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [agents, setAgents] = useState([]);
  const reloadRooms = () => api("/api/call/backgrounds").then(setRooms, () => {});
  const reloadAgents = () => api("/api/agents").then((l) => setAgents(l || []), () => {});
  useEffect(() => {
    api("/api/call/voices").then(setVoices, () => {});
    reloadRooms();
    reloadAgents();
  }, []);
  if (!sub) return html`<${Gallery} api=${api} look=${look} agents=${agents} rooms=${rooms} reloadAgents=${reloadAgents} voices=${voices} />`;
  const found = look.doc.persons.find((p) => p.id === sub);
  if (sub !== "new" && !found) return html`<p class="sub">Nobody here by that name. <a href="#/settings/persons">Back to Persons</a></p>`;
  const first = look.names.find((n) => look.kinds[n] === "rig") || "orb";
  const draft = found || { name: "", character: first, background: "", voices: Object.fromEntries(Object.entries(voices || {}).map(([l, v]) => [l, v.current])) };
  /* A new person starts on today's voices, so it waits for them. */
  if (sub === "new" && !voices) return html`<p class="sub">Loading the voices</p>`;
  return html`<${Editor} key=${sub} api=${api} look=${look} voices=${voices} rooms=${rooms} reloadRooms=${reloadRooms} draft=${draft} Preview=${Preview} onDone=${() => go("#/settings/persons")} />`;
}
