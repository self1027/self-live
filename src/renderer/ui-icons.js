const paths = {
  settings: '<path d="m9 3 1-1h4l1 1 1 3 3 1 1 1v4l-1 1-3 1-1 3-1 1h-4l-1-1-1-3-3-1-1-1V8l1-1 3-1Z"/><circle cx="12" cy="10" r="3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 7a8 8 0 0 1 14-1l1 6M4 12l1 6a8 8 0 0 0 14-1"/>',
  fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  panels: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M16 4v16"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  screen: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>'
};
export function icon(name) {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.settings}</svg>`;
}
export function iconButton(button, name, label) {
  button.innerHTML = icon(name);
  button.classList.add('icon-button'); button.title = label;
  button.setAttribute('aria-label', label);
}
