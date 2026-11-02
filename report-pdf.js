// "Download PDF" for sales.html and vnumber.html: captures the page exactly as
// it is filtered on screen (one image per section), lays the sections out on
// A4 landscape pages and downloads the file. html2canvas and jsPDF load on the
// first click only.
(function(){
  const LIBS = [
    'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  ];
  const load = src => new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script'); s.src = src; s.onload = res;
    s.onerror = () => rej(new Error('The PDF tools could not be loaded. Check the connection and try again.'));
    document.head.appendChild(s);
  });
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // Charts size themselves to their box; make them redraw at the new width before capturing.
  const redraw = async () => { await wait(50); if (window.Chart) Object.values(Chart.instances || {}).forEach(c => { try { c.resize(); } catch {} }); window.dispatchEvent(new Event('resize')); await wait(400); };
  const toast = m => { const el = document.getElementById('toast'); if (!el) return; el.textContent = m; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, 6000); };

  async function build(btn){
    const title = btn.dataset.report || document.title;
    const sel = document.getElementById('month'), month = sel?.selectedOptions[0]?.text.replace(/\s+/g, '-') || '';
    // Filters that differ from the default go into the file name, so differently filtered reports don't collide.
    const tag = [];
    const vn = document.querySelector('#vn button[aria-pressed="true"]'); if (vn && vn.dataset.v) tag.push(vn.textContent);
    const ty = document.getElementById('type'); if (ty && ty.value) tag.push(ty.value);
    const chips = [...document.querySelectorAll('#markets .chip')], on = chips.filter(c => c.getAttribute('aria-pressed') === 'true');
    if (chips.length && on.length < chips.length) tag.push(on.map(c => c.dataset.m).join('-'));
    const flag = document.getElementById('flag'); if (flag && flag.value) tag.push(flag.selectedOptions[0].text);
    const q = document.getElementById('q'); if (q && q.value.trim()) tag.push('search-' + q.value.trim());
    const label = btn.textContent; btn.disabled = true; btn.textContent = 'Preparing PDF…';
    try {
      for (const src of LIBS) await load(src);
      const { jsPDF } = window.jspdf;
      // A fixed layout width makes every PDF look the same whatever the screen size.
      document.body.classList.add('pdf');
      await redraw();
      const blocks = [...document.querySelectorAll('#app > *')].filter(el => !el.hidden && el.offsetHeight > 0 && getComputedStyle(el).display !== 'none');
      const bg = getComputedStyle(document.body).backgroundColor || '#ffffff';
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
      const W = 297, H = 210, M = 10, top = 16, bottom = 12, cw = W - 2 * M, ch = H - top - bottom, gap = 4;
      let y = top, page = 1;
      const by = document.getElementById('user-display')?.textContent || '';
      const stamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
      const chrome = () => {
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(196, 98, 4);
        pdf.text('011 Global · ' + title, M, 9);
        pdf.setFont('helvetica', 'normal'); pdf.setTextColor(136, 136, 136);
        pdf.text(`Generated ${stamp}${by ? ' by ' + by : ''}`, W - M, 9, { align: 'right' });
        pdf.setFontSize(8); pdf.text(`Page ${page}`, W - M, H - 5, { align: 'right' });
        pdf.text('Confidential · internal use only', M, H - 5);
      };
      chrome();
      const newPage = () => { pdf.addPage(); page++; y = top; chrome(); };
      for (const el of blocks) {
        btn.textContent = `Preparing PDF… ${Math.round((blocks.indexOf(el) / blocks.length) * 100)}%`;
        // Row and panel edges, so a page break never cuts through a table row.
        const top0 = el.getBoundingClientRect().top;
        const edges = [...el.querySelectorAll('tr, .panel, .ph, .detail')].map(n => n.getBoundingClientRect().bottom - top0);
        const canvas = await html2canvas(el, { scale: 2, backgroundColor: bg, logging: false, useCORS: true });
        const k = canvas.height / el.offsetHeight, cuts = edges.map(e => Math.round(e * k)).sort((a, b) => a - b);
        const mmPerPx = cw / canvas.width, hmm = canvas.height * mmPerPx;
        if (hmm <= ch) {
          if (y + hmm > top + ch) newPage();
          pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', M, y, cw, hmm);
          y += hmm + gap;
        } else {
          // Taller than a page (a long table): continue it across pages.
          if (y > top + 20) newPage();
          let sy = 0;
          while (sy < canvas.height) {
            const room = top + ch - y, max = Math.min(canvas.height - sy, Math.floor(room / mmPerPx));
            const edge = sy + max >= canvas.height ? null : cuts.filter(c => c > sy + max * 0.5 && c <= sy + max).pop();
            const sh = edge ? edge - sy : max;
            const part = document.createElement('canvas'); part.width = canvas.width; part.height = sh;
            part.getContext('2d').drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
            pdf.addImage(part.toDataURL('image/jpeg', 0.9), 'JPEG', M, y, cw, sh * mmPerPx);
            sy += sh; y += sh * mmPerPx + gap;
            if (sy < canvas.height) newPage();
          }
        }
      }
      const name = [title, month, ...tag].filter(Boolean).join(' ').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.pdf';
      pdf.save(name);
      toast(`Downloaded ${name}`);
    } catch (e) {
      console.error(e);
      toast(e.message || 'The PDF could not be created. Try again.');
    } finally {
      document.body.classList.remove('pdf');
      redraw();
      btn.disabled = false; btn.textContent = label;
    }
  }
  document.addEventListener('click', e => { const b = e.target.closest('#pdf'); if (b && !b.disabled) build(b); });
})();
