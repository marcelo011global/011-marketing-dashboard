// Who can open which page. One doc per person in Firestore:
//   mkt_access/{email, lowercase} = { email, role, pages: [page keys], updatedBy, updatedAt }
// role 'admin' opens every page and manages people on users.html; any other role uses `pages`.
// Nobody without a doc gets in. The Firestore rules (firestore.rules) enforce the same
// thing on the data itself, so hiding a link here is only the visible half.
import { doc, getDoc, getDocs, setDoc, collection, query, limit, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

export const PAGES = [
  { k: 'sales',       l: 'Sales',       files: ['sales.html'] },
  { k: 'vnumber',     l: 'VNUMBER',     files: ['vnumber.html', 'enrollments.html'] },
  { k: 'subscribers', l: 'Subscribers', files: ['subscribers.html'] },
  { k: 'recharge',    l: 'Recharge',    files: ['recharge.html'] },
  { k: 'globusim',    l: 'Globusim',    files: ['sims.html'] },
  { k: 'seo',         l: 'SEO',         files: ['seo.html'] },
  { k: 'paid',        l: 'Paid media',  files: ['index.html', ''] },
];
const ALL = PAGES.map(p => p.k);
// Presets: picking one ticks its pages; ticking more or fewer makes it "custom".
export const ROLES = {
  admin:     { l: 'Admin',      pages: ALL, note: 'Every page, and can manage users' },
  marketing: { l: 'Marketing',  pages: ['paid', 'seo'] },
  seo:       { l: 'SEO agency', pages: ['seo'] },
  finance:   { l: 'Finance',    pages: ['sales', 'vnumber', 'subscribers', 'recharge', 'globusim'] },
  custom:    { l: 'Custom',     pages: [] },
};
export const emailKey = e => String(e || '').trim().toLowerCase();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const fileOf = href => (String(href).split('#')[0].split('?')[0].split('/').pop() || 'index.html');
export const pageOfFile = f => PAGES.find(p => p.files.includes(f))?.k || null;
export const currentPage = () => pageOfFile(fileOf(location.pathname));
const hrefOf = k => k === 'paid' ? 'index.html#/performance' : PAGES.find(p => p.k === k).files[0];

const LOCAL = ['localhost','127.0.0.1'].includes(location.hostname);
// Local preview only: ?preview&role=seo (or &pages=seo,paid) previews what that person would see.
export function previewAccess(){
  const q = new URLSearchParams(location.search), role = q.get('role') || 'admin';
  const pages = q.get('pages') ? q.get('pages').split(',') : (ROLES[role] || ROLES.admin).pages;
  return make({ role, pages });
}
function make(x){
  const admin = x?.role === 'admin';
  return { role: x?.role || null, admin, pages: new Set(admin ? ALL : (x?.pages || []).filter(k => ALL.includes(k))) };
}

export async function getAccess(db, user){
  if (!user) return make(null);
  const d = await getDoc(doc(db, 'mkt_access', emailKey(user.email))).catch(e => { console.warn('access', e.message); return null; });
  if (d?.exists()) return make(d.data());
  // First run only: while nobody is set up (and the rules are not published yet) the list
  // reads as empty, so the first person in can make themselves admin. Once rules are live,
  // a person without a doc cannot list it and this stays false.
  const acc = make(null);
  try { acc.bootstrap = (await getDocs(query(collection(db, 'mkt_access'), limit(1)))).empty; } catch { acc.bootstrap = false; }
  return acc;
}
export const can = (acc, k) => !!acc?.pages.has(k);
export const firstHref = acc => { const p = PAGES.find(p => acc.pages.has(p.k)); return p ? hrefOf(p.k) : null; };

// Hide top-bar links the person cannot open; admins also get a "Users" link.
export function applyNav(acc){
  const links = [...document.querySelectorAll('a.nav-btn')];
  links.forEach(a => { const k = pageOfFile(fileOf(a.getAttribute('href'))); if (k && !acc.pages.has(k)) a.style.display = 'none'; });
  document.querySelectorAll('a.logo').forEach(a => { if (!acc.pages.has('paid')) { const h = firstHref(acc); if (h) a.setAttribute('href', h); } });
  if (acc.admin && links.length && !document.getElementById('nav-users')) {
    const u = document.createElement('a');
    u.className = 'nav-btn' + (fileOf(location.pathname) === 'users.html' ? ' active' : ''); u.id = 'nav-users'; u.href = 'users.html'; u.textContent = 'Users';
    links[links.length - 1].after(u);
  }
}

// Full-page message for someone without access to this page (or any page).
export function blockPage(acc, user, db, label, onSignOut){
  const others = PAGES.filter(p => acc.pages.has(p.k));
  const el = document.createElement('div');
  el.id = 'no-access';
  el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#F7F6F4;display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit';
  el.innerHTML = `<div style="max-width:460px;background:#fff;border:1px solid #E7E5E4;border-radius:12px;padding:28px;color:#1C1917">
    <h1 style="font-size:20px;margin:0 0 8px">${acc.bootstrap ? 'Set up access' : others.length ? `No access to ${esc(label)}` : 'No access yet'}</h1>
    <p style="color:#57534E;line-height:1.5;margin:0 0 16px">${acc.bootstrap
      ? `Nobody has been given access yet. Make <b>${esc(user.email)}</b> the first admin, then add everyone else on the Users page.`
      : `${esc(user.email)} ${others.length ? `can't open ${esc(label)}.` : `hasn't been given access to the marketing dashboard.`} Ask an admin to add it on the Users page.`}</p>
    ${others.length ? `<p style="margin:0 0 16px;display:flex;gap:8px;flex-wrap:wrap">${others.map(p => `<a href="${hrefOf(p.k)}" style="padding:7px 12px;border-radius:8px;background:#FDF0E6;color:#C25E00;font-weight:600;text-decoration:none">${esc(p.l)}</a>`).join('')}</p>` : ''}
    <p style="margin:0;display:flex;gap:8px">${acc.bootstrap ? '<button type="button" id="acc-boot" style="padding:8px 14px;border-radius:8px;border:0;background:#EE7805;color:#fff;font-weight:600;cursor:pointer">Make me admin</button>' : ''}
      <button type="button" id="acc-out" style="padding:8px 14px;border-radius:8px;border:1px solid #D6D3D1;background:#fff;cursor:pointer">Sign out</button></p></div>`;
  document.getElementById('no-access')?.remove();
  document.body.appendChild(el);
  el.querySelector('#acc-out').onclick = onSignOut;
  const b = el.querySelector('#acc-boot');
  if (b) b.onclick = async () => {
    b.disabled = true;
    try { await setDoc(doc(db, 'mkt_access', emailKey(user.email)), { email: emailKey(user.email), role: 'admin', pages: [], updatedBy: user.email, updatedAt: serverTimestamp() }); location.reload(); }
    catch (e) { b.disabled = false; alert('Could not save: ' + e.message); }
  };
}

// One call for a page: read access, hide links, block if needed. Returns acc, or null when blocked.
export async function guard(db, user, onSignOut, pageKey = currentPage()){
  const preview = LOCAL && new URLSearchParams(location.search).has('preview');
  const acc = preview ? previewAccess() : await getAccess(db, user);
  if (preview) user = { email: 'preview@localhost' };
  applyNav(acc);
  if (pageKey === 'users' ? !acc.admin : !acc.pages.has(pageKey)) {
    // The sign-in page (Paid media) forwards people to the first page they can open.
    const h = pageKey === 'paid' && firstHref(acc);
    if (h) { location.replace(preview ? h.replace(/(#|$)/, location.search + '$1') : h); return null; }
    blockPage(acc, user, db, pageKey === 'users' ? 'Users' : PAGES.find(p => p.k === pageKey)?.l || 'this page', onSignOut);
    return null;
  }
  return acc;
}
