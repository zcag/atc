import { html } from "./vendor/preact-htm.js";

export const Empty = ({ children, act, label, cls = "" }) => html`<div class="emp ${cls}"><p>${children}</p>${act && label && html`<button class="btn" onClick=${act}>${label}</button>`}</div>`;

export const Err = ({ what, why, fix, label = "Retry", cls = "" }) => html`<p class="err ${cls}" role="alert"><b>${what}</b>${why && html` ${why}`}${fix && html` <button class="vlink" onClick=${fix}>${label}</button>`}</p>`;
