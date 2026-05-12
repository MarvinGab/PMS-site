import { useState, useRef, useEffect } from 'react';
import zaroLogo from '../../images/final zaro logo.png';
import { uploadBrandAsset, uploadEmailLogoAsset, ensureDefaultZaroLogoUrl } from '../backend/brandAssetStorage';

// EmailDesigner — WYSIWYG email designer with click-to-select blocks and a
// contextual inspector panel. Click any element in the canvas to edit it; text
// blocks support inline editing via contentEditable.
//
// Props:
//   blocks     — current block model (from globalEmailTemplate)
//   onChange   — (newBlocks) => void
//   tokens     — { organization_name, first_name, ... } sample values
//   accent     — falls back from theme.brand if blocks.header.accentColor isn't set
export default function EmailDesigner({ blocks, onChange, tokens = {}, supportEmail = 'support@zarohr.com' }) {
  const [selected, setSelected] = useState(null); // 'header'|'greeting'|`body:${id}`|'credentials'|'button'|'signature'|'footer'
  const canvasRef = useRef(null);

  function patch(key, value) {
    onChange({ ...blocks, [key]: { ...(blocks[key] || {}), ...value } });
  }
  function patchBody(id, value) {
    onChange({ ...blocks, body: blocks.body.map((b) => (b.id === id ? { ...b, ...value } : b)) });
  }
  function addBodyParagraph() {
    const id = `b_${Math.random().toString(36).slice(2, 8)}`;
    onChange({ ...blocks, body: [...blocks.body, { id, text: 'New paragraph.', color: '#111827', align: 'left' }] });
    setSelected(`body:${id}`);
  }
  function removeBodyParagraph(id) {
    if (blocks.body.length <= 1) return;
    onChange({ ...blocks, body: blocks.body.filter((b) => b.id !== id) });
    setSelected(null);
  }
  function moveBody(id, dir) {
    const idx = blocks.body.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const next = [...blocks.body];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    onChange({ ...blocks, body: next });
  }
  function reorderBody(fromId, toId, position /* 'before' | 'after' */) {
    if (fromId === toId) return;
    const list = [...blocks.body];
    const fromIdx = list.findIndex((b) => b.id === fromId);
    if (fromIdx < 0) return;
    const [moved] = list.splice(fromIdx, 1);
    const toIdx = list.findIndex((b) => b.id === toId);
    if (toIdx < 0) return;
    const insertAt = position === 'after' ? toIdx + 1 : toIdx;
    list.splice(insertAt, 0, moved);
    onChange({ ...blocks, body: list });
  }

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') setSelected(null); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // tokens are unused in the canvas (we show raw {tokens} so users can edit
  // around them) — they're kept on the prop for downstream renderers.
  void tokens;

  const accent = blocks.header.accentColor || '#4F46E5';
  const isSelected = (key) => selected === key;

  // Body background derived from blocks.bodyStyle. Plain = white. color/gradient/image
  // wrap the body sections in a single styled container so the user can paint the
  // canvas behind the heading, paragraphs, credentials, button, signature.
  const bs = blocks.bodyStyle || {};
  const bodyBg =
    bs.background === 'image'    && bs.image    ? `#fff url(${bs.image}) center/cover no-repeat`
  : bs.background === 'gradient'                ? `linear-gradient(180deg, ${bs.color || '#fff'} 0%, ${bs.gradientTo || '#F1F5F9'} 100%)`
  : bs.background === 'color'                   ? bs.color || '#ffffff'
  : '#ffffff';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 18, alignItems: 'start' }}>
      <FloatingTextToolbar />
      {/* Canvas */}
      <div ref={canvasRef} onClick={(e) => { if (e.target === canvasRef.current) setSelected(null); }}
        style={{ background: '#F1F5F9', borderRadius: 16, padding: '20px', minHeight: 600 }}>
        <div style={{ maxWidth: 640, margin: '0 auto', background: '#fff', borderRadius: 14, overflow: 'hidden', boxShadow: '0 12px 32px rgba(15,23,42,.10)' }}>
          {/* Header block */}
          <SelectableBlock label="Header" selected={isSelected('header')} onSelect={() => setSelected('header')}>
            <HeaderRender header={blocks.header} accent={accent} />
          </SelectableBlock>

          {/* Body container — selectable so user can paint a background */}
          <SelectableBlock label="Body background" selected={isSelected('bodyStyle')} onSelect={() => setSelected('bodyStyle')}>
          <div style={{ background: bodyBg }}>
          <div style={{ padding: '24px 28px 0' }}>
            <SelectableBlock label="Heading" selected={isSelected('greeting')} onSelect={() => setSelected('greeting')}>
              <EditableText
                tag="h1"
                value={blocks.greeting.text}
                color={blocks.greeting.color}
                align={blocks.greeting.align}
                size={blocks.greeting.size === 'small' ? 18 : blocks.greeting.size === 'medium' ? 22 : 26}
                weight={700}
                onCommit={(text) => patch('greeting', { text })}
                placeholder="Heading text"
              />
            </SelectableBlock>
          </div>

          {/* Body paragraphs */}
          <div style={{ padding: '8px 28px 0' }}>
            {blocks.body.map((p) => (
              <DraggableParagraph
                key={p.id}
                paragraph={p}
                selected={isSelected(`body:${p.id}`)}
                onSelect={() => setSelected(`body:${p.id}`)}
                onCommit={(text) => patchBody(p.id, { text })}
                onReorder={reorderBody}
                multi={blocks.body.length > 1}
              />
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-start', padding: '6px 0 6px' }}>
              <button type="button" onClick={addBodyParagraph}
                style={{ padding: '6px 12px', background: 'transparent', border: '1.5px dashed #C7D2FE', color: '#4338CA', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                + Add paragraph
              </button>
            </div>
          </div>

          {/* Credentials */}
          {blocks.credentials.enabled && (
            <div style={{ padding: '6px 28px 16px' }}>
              <SelectableBlock label="Credentials block" selected={isSelected('credentials')} onSelect={() => setSelected('credentials')}>
                <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 12, padding: '18px 20px' }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.04em', color: '#6B7280', textTransform: 'uppercase', marginBottom: 4 }}>Login email</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#111827', marginBottom: 12 }}>{tokens.recipient_email || 'admin@example.com'}</div>
                  <div style={{ borderTop: '1px solid #E5E7EB', paddingTop: 12 }}>
                    <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '.04em', color: '#6B7280', textTransform: 'uppercase', marginBottom: 4 }}>Temporary password</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 14, color: '#111827' }}>{tokens.temporary_password || 'TempPass123'}</div>
                    <div style={{ display: 'inline-block', marginTop: 8, padding: '2px 8px', fontSize: 11, color: '#6B7280', border: '1px solid #E5E7EB', borderRadius: 999, background: '#fff' }}>Temporary · change on first login</div>
                  </div>
                </div>
              </SelectableBlock>
            </div>
          )}

          {/* Button */}
          <div style={{ padding: '0 28px 24px' }}>
            <SelectableBlock label="Button" selected={isSelected('button')} onSelect={() => setSelected('button')}>
              <ButtonRender button={blocks.button} />
            </SelectableBlock>
          </div>

          {/* Signature */}
          {blocks.signature.enabled && (
            <div style={{ padding: '0 28px 22px' }}>
              <SelectableBlock label="Signature" selected={isSelected('signature')} onSelect={() => setSelected('signature')}>
                <SignatureRender signature={blocks.signature} />
              </SelectableBlock>
            </div>
          )}

          </div>{/* end body bg container */}
          </SelectableBlock>{/* end body bodyStyle selectable */}

          {/* Footer */}
          {blocks.footer.show && (
            <SelectableBlock label="Footer" selected={isSelected('footer')} onSelect={() => setSelected('footer')}>
              <div style={{ borderTop: '1px solid #E5E7EB', padding: '16px 28px', background: '#F9FAFB', fontSize: 12, color: '#6B7280' }}>
                <div>{blocks.footer.text}</div>
                <div style={{ marginTop: 6 }}>
                  <a href={`mailto:${supportEmail}`} onClick={(e) => e.preventDefault()} style={{ color: '#6B7280' }}>Support</a>
                </div>
                {blocks.footer.showBadge && <div style={{ marginTop: 6 }}>© {new Date().getFullYear()} Zaro HR. All rights reserved.</div>}
              </div>
            </SelectableBlock>
          )}
        </div>
      </div>

      {/* Inspector */}
      <Inspector
        blocks={blocks}
        selected={selected}
        onSelect={setSelected}
        patch={patch}
        patchBody={patchBody}
        moveBody={moveBody}
        removeBody={removeBodyParagraph}
      />
    </div>
  );
}

/* ── Block primitives ─────────────────────────────────────────── */

// Paragraph wrapper with a left-edge drag handle (⋮⋮). Drag onto another
// paragraph to reorder. Drop position (above/below) follows pointer y.
function DraggableParagraph({ paragraph, selected, onSelect, onCommit, onReorder, multi }) {
  const [hovered, setHovered] = useState(false);
  const [dropZone, setDropZone] = useState(null); // 'above' | 'below' | null
  const wrapRef = useRef(null);

  function onDragStart(e) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', paragraph.id);
  }
  function onDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const fromId = e.dataTransfer.types.includes('text/plain');
    if (!fromId) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    setDropZone(e.clientY - rect.top < rect.height / 2 ? 'above' : 'below');
  }
  function onDragLeave() { setDropZone(null); }
  function onDrop(e) {
    e.preventDefault();
    const fromId = e.dataTransfer.getData('text/plain');
    setDropZone(null);
    if (!fromId || fromId === paragraph.id) return;
    onReorder(fromId, paragraph.id, dropZone === 'above' ? 'before' : 'after');
  }

  const ring = selected ? '2px solid #4F46E5' : hovered ? '2px solid rgba(79,70,229,.4)' : '2px solid transparent';

  return (
    <div
      ref={wrapRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setDropZone(null); }}
      onDragOver={multi ? onDragOver : undefined}
      onDragLeave={multi ? onDragLeave : undefined}
      onDrop={multi ? onDrop : undefined}
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      style={{ position: 'relative', outline: ring, outlineOffset: 2, borderRadius: 8, transition: 'outline-color 120ms ease', padding: '4px 0', cursor: 'pointer' }}
    >
      {(hovered || selected) && (
        <div style={{ position: 'absolute', top: -22, left: 0, fontSize: 10.5, fontWeight: 700, color: '#fff', background: '#4F46E5', padding: '2px 8px', borderRadius: 999, letterSpacing: '.04em', textTransform: 'uppercase', zIndex: 2, pointerEvents: 'none' }}>
          Paragraph{multi ? ' · drag to reorder' : ''}
        </div>
      )}
      {multi && (hovered || selected) && (
        <div
          draggable
          onDragStart={onDragStart}
          title="Drag to reorder"
          style={{ position: 'absolute', left: -26, top: '50%', transform: 'translateY(-50%)', cursor: 'grab', color: '#94A3B8', userSelect: 'none', padding: 4, fontSize: 14 }}
          onMouseDown={(e) => { e.stopPropagation(); }}
        >
          ⋮⋮
        </div>
      )}
      {dropZone === 'above' && <div style={{ position: 'absolute', top: -2, left: -4, right: -4, height: 3, background: '#4F46E5', borderRadius: 2 }} />}
      {dropZone === 'below' && <div style={{ position: 'absolute', bottom: -2, left: -4, right: -4, height: 3, background: '#4F46E5', borderRadius: 2 }} />}
      <EditableText
        tag="p"
        value={paragraph.text}
        color={paragraph.color}
        align={paragraph.align}
        size={15}
        weight={400}
        onCommit={onCommit}
        placeholder="Paragraph text"
      />
    </div>
  );
}

function SelectableBlock({ label, selected, onSelect, children }) {
  const [hovered, setHovered] = useState(false);
  const ring = selected ? '2px solid #4F46E5' : hovered ? '2px solid rgba(79,70,229,.4)' : '2px solid transparent';
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: 'relative', outline: ring, outlineOffset: 2, borderRadius: 8, transition: 'outline-color 120ms ease', cursor: 'pointer' }}
    >
      {(hovered || selected) && (
        <div style={{ position: 'absolute', top: -22, left: 0, fontSize: 10.5, fontWeight: 700, color: '#fff', background: '#4F46E5', padding: '2px 8px', borderRadius: 999, letterSpacing: '.04em', textTransform: 'uppercase', zIndex: 2, pointerEvents: 'none' }}>
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

// Allowlist sanitizer — keep only inline formatting we ship in emails.
function sanitizeRichHtml(html) {
  if (typeof DOMParser === 'undefined') return String(html || '');
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const root = doc.body.firstChild;
  if (!root) return '';
  const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'SPAN']);
  function walk(node) {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === 3) return; // text
      if (child.nodeType !== 1) { node.removeChild(child); return; }
      const tag = child.tagName;
      if (!ALLOWED.has(tag)) {
        // Replace with its text content
        const text = doc.createTextNode(child.textContent || '');
        node.replaceChild(text, child);
        return;
      }
      // Strip all attributes except `style="color:..."` on SPAN
      [...child.attributes].forEach((attr) => {
        if (tag === 'SPAN' && attr.name === 'style') {
          const safe = String(attr.value || '').match(/color\s*:\s*[#a-zA-Z0-9(),.\s%]+/g)?.join(';') || '';
          if (safe) child.setAttribute('style', safe);
          else child.removeAttribute('style');
        } else {
          child.removeAttribute(attr.name);
        }
      });
      walk(child);
    });
  }
  walk(root);
  return root.innerHTML;
}

function EditableText({ tag, value, color, align, size, weight, onCommit, placeholder, multiline = true }) {
  const ref = useRef(null);
  const draftRef = useRef(value);

  useEffect(() => {
    // Show the raw template text (with `{tokens}` visible) so users can edit
    // around them. Resolution happens at email-send / preview-render time.
    if (!ref.current) return;
    if (ref.current === document.activeElement) return;
    ref.current.innerHTML = value || '';
    draftRef.current = value;
  }, [value]);

  function onBlur() {
    const raw = ref.current?.innerHTML ?? '';
    const next = sanitizeRichHtml(raw);
    if (next !== draftRef.current) { draftRef.current = next; onCommit(next); }
  }

  const Tag = tag || 'div';
  return (
    <Tag
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onBlur={onBlur}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') e.currentTarget.blur();
        if (!multiline && e.key === 'Enter') e.preventDefault();
      }}
      data-placeholder={placeholder}
      data-rich-editor="1"
      style={{
        margin: 0,
        outline: 'none',
        color: color || '#111827',
        textAlign: align || 'left',
        fontSize: size || 15,
        lineHeight: 1.55,
        fontWeight: weight || 400,
        cursor: 'text',
        minHeight: '1.4em',
      }}
    />
  );
}

// Floating selection toolbar — bold / italic / underline / color. Lives at the
// document level and tracks `selectionchange`. Only appears when there's a
// non-empty selection inside a `[data-rich-editor]` element.
function FloatingTextToolbar() {
  const [pos, setPos] = useState(null); // { top, left } | null
  const [showColor, setShowColor] = useState(false);
  useEffect(() => {
    function onSel() {
      const sel = window.getSelection?.();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { setPos(null); return; }
      const range = sel.getRangeAt(0);
      const anchor = range.startContainer;
      const editor = (anchor.nodeType === 1 ? anchor : anchor.parentElement)?.closest?.('[data-rich-editor="1"]');
      if (!editor) { setPos(null); return; }
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) { setPos(null); return; }
      setPos({ top: rect.top + window.scrollY - 44, left: rect.left + window.scrollX + rect.width / 2 });
    }
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  function applyCmd(cmd, value = null) {
    document.execCommand(cmd, false, value);
  }

  if (!pos) return null;
  const COLORS = ['#111827', '#4F46E5', '#16A34A', '#EA580C', '#E11D48', '#7C3AED', '#0EA5E9'];
  return (
    <div onMouseDown={(e) => e.preventDefault()} style={{ position: 'absolute', top: pos.top, left: pos.left, transform: 'translateX(-50%)', background: '#0F172A', color: '#fff', borderRadius: 8, padding: '4px 6px', display: 'inline-flex', gap: 2, alignItems: 'center', boxShadow: '0 8px 24px rgba(0,0,0,.18)', zIndex: 9999, fontFamily: 'inherit' }}>
      <button type="button" onClick={() => applyCmd('bold')} title="Bold" style={tbBtn}><b>B</b></button>
      <button type="button" onClick={() => applyCmd('italic')} title="Italic" style={tbBtn}><i>I</i></button>
      <button type="button" onClick={() => applyCmd('underline')} title="Underline" style={tbBtn}><u>U</u></button>
      <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,.2)', margin: '0 4px' }} />
      <div style={{ position: 'relative' }}>
        <button type="button" onClick={() => setShowColor((v) => !v)} title="Color" style={tbBtn}>A</button>
        {showColor && (
          <div onMouseDown={(e) => e.preventDefault()} style={{ position: 'absolute', top: '100%', left: 0, background: '#0F172A', borderRadius: 8, padding: 6, marginTop: 4, display: 'flex', gap: 4, boxShadow: '0 8px 24px rgba(0,0,0,.18)' }}>
            {COLORS.map((c) => (
              <button key={c} type="button" onClick={() => { applyCmd('foreColor', c); setShowColor(false); }} style={{ width: 18, height: 18, borderRadius: 4, padding: 0, border: '1px solid rgba(255,255,255,.2)', background: c, cursor: 'pointer' }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
const tbBtn = { background: 'transparent', color: '#fff', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 13, fontWeight: 600, cursor: 'pointer', minWidth: 22, fontFamily: 'inherit' };

function HeaderRender({ header, accent }) {
  const bg = header.background === 'gradient'
    ? `linear-gradient(135deg, ${accent} 0%, ${darken(accent, 0.22)} 100%)`
    : header.background === 'tint'
    ? `linear-gradient(180deg, ${withAlpha(accent, 0.08)} 0%, #ffffff 100%)`
    : '#ffffff';
  const fg = header.background === 'gradient' ? '#fff' : '#111827';
  const justify = header.alignment === 'center' ? 'center' : header.alignment === 'right' ? 'flex-end' : 'flex-start';
  const showLogo = header.logo && (header.display === 'logo' || header.display === 'both');
  const showText = header.display === 'text' || header.display === 'both';
  return (
    <div style={{ background: bg, padding: '20px 28px', display: 'flex', justifyContent: justify, alignItems: 'center', gap: 12, borderBottom: '1px solid #E5E7EB' }}>
      {showLogo && <img src={header.logo} alt={header.brandName || 'Logo'} style={{ height: 32, maxWidth: 180, objectFit: 'contain' }} />}
      {showText && (
        <span style={{ fontSize: 17, fontWeight: 700, color: fg }}>
          {(() => {
            const parts = String(header.brandName || '').split(/\s+/).filter(Boolean);
            if (parts.length <= 1) return <span style={{ color: header.background === 'gradient' ? '#fff' : accent }}>{header.brandName || 'Brand'}</span>;
            const last = parts.pop();
            return <>{parts.join(' ')} <span style={{ color: header.background === 'gradient' ? '#fff' : accent }}>{last}</span></>;
          })()}
        </span>
      )}
    </div>
  );
}

function ButtonRender({ button }) {
  const base = { fontSize: 15, fontWeight: 700, padding: '12px 22px', borderRadius: 8, textDecoration: 'none', display: 'inline-block', cursor: 'pointer', border: 'none' };
  let inline;
  if (button.style === 'outline') inline = { ...base, background: '#fff', color: button.color, border: `2px solid ${button.color}` };
  else if (button.style === 'pill') inline = { ...base, background: button.color, color: '#fff', borderRadius: 999 };
  else if (button.style === 'ghost') inline = { ...base, background: 'transparent', color: button.color, padding: '6px 0', textDecoration: 'underline', borderRadius: 0 };
  else inline = { ...base, background: button.color, color: '#fff' };
  const justify = button.align === 'center' ? 'center' : button.align === 'right' ? 'flex-end' : 'flex-start';
  return (
    <div style={{ display: 'flex', justifyContent: justify }}>
      <a href="#" onClick={(e) => e.preventDefault()} style={inline}>{button.label || 'Button'}</a>
    </div>
  );
}

function SignatureRender({ signature }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', borderTop: '1px solid #E5E7EB', paddingTop: 16 }}>
      {signature.image && <img src={signature.image} alt="" style={{ width: 44, height: 44, borderRadius: '50%', objectFit: 'cover' }} />}
      <div style={{ fontSize: 13, color: '#374151' }}>
        <div style={{ fontWeight: 700, color: '#111827' }}>{signature.name || 'Your name'}</div>
        {signature.title && <div style={{ color: '#6B7280' }}>{signature.title}</div>}
      </div>
    </div>
  );
}

/* ── Inspector ───────────────────────────────────────────────── */

function Inspector({ blocks, selected, onSelect, patch, patchBody, moveBody, removeBody }) {
  const card = { background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 14 };
  if (!selected) {
    return (
      <div style={{ ...card, position: 'sticky', top: 16, fontSize: 12.5, color: '#6B7280', lineHeight: 1.5 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 6 }}>Click a block to edit</div>
        Click on any element in the email canvas to edit its text, color, alignment, or other properties. Press <kbd style={kbd}>Esc</kbd> to deselect.
      </div>
    );
  }
  if (selected === 'header')      return <HeaderInspector header={blocks.header} patch={(v) => patch('header', v)} />;
  if (selected === 'bodyStyle')   return <BodyStyleInspector bodyStyle={blocks.bodyStyle || {}} patch={(v) => patch('bodyStyle', v)} />;
  if (selected === 'greeting')    return <GreetingInspector greeting={blocks.greeting} patch={(v) => patch('greeting', v)} />;
  if (selected.startsWith('body:')) {
    const id = selected.slice(5);
    const para = blocks.body.find((b) => b.id === id);
    if (!para) return null;
    return <BodyInspector
      paragraph={para}
      patch={(v) => patchBody(id, v)}
      onMoveUp={() => moveBody(id, -1)}
      onMoveDown={() => moveBody(id, +1)}
      onRemove={() => removeBody(id)}
      canRemove={blocks.body.length > 1}
    />;
  }
  if (selected === 'credentials') return <CredentialsInspector enabled={blocks.credentials.enabled} patch={(v) => patch('credentials', v)} />;
  if (selected === 'button')      return <ButtonInspector button={blocks.button} patch={(v) => patch('button', v)} />;
  if (selected === 'signature')   return <SignatureInspector signature={blocks.signature} patch={(v) => patch('signature', v)} />;
  if (selected === 'footer')      return <FooterInspector footer={blocks.footer} patch={(v) => patch('footer', v)} />;
  return null;
}

const kbd = { background: '#F3F4F6', border: '1px solid #E5E7EB', borderRadius: 4, padding: '0 6px', fontSize: 11, fontFamily: 'monospace', color: '#374151' };
const sectionTitle = { fontSize: 13, fontWeight: 700, color: '#111827', marginBottom: 10 };
const fieldLabel  = { display: 'block', fontSize: 11, fontWeight: 600, color: '#6B7280', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 5 };
const fieldInput  = { width: '100%', boxSizing: 'border-box', border: '1.5px solid #E5E7EB', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit', color: '#111827', background: '#fff' };
const segWrap     = { display: 'inline-flex', gap: 4, background: '#F1F5F9', padding: 3, borderRadius: 8 };
const seg = (active) => ({ padding: '5px 10px', borderRadius: 6, border: 'none', background: active ? '#fff' : 'transparent', color: active ? '#111827' : '#6B7280', fontWeight: active ? 700 : 500, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', boxShadow: active ? '0 1px 3px rgba(15,23,42,.08)' : 'none', textTransform: 'capitalize' });
const PALETTE = ['#4F46E5', '#0EA5E9', '#16A34A', '#EA580C', '#7C3AED', '#0F172A', '#E11D48'];

function ColorRow({ value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {PALETTE.map((c) => {
        const active = String(value || '').toLowerCase() === c.toLowerCase();
        return <button key={c} type="button" onClick={() => onChange(c)} style={{ width: 22, height: 22, borderRadius: 999, padding: 0, border: `2px solid ${active ? '#0F172A' : 'transparent'}`, background: c, cursor: 'pointer', boxShadow: active ? '0 0 0 2px rgba(15,23,42,.08)' : 'inset 0 0 0 1px rgba(15,23,42,.08)' }} />;
      })}
      <label style={{ position: 'relative', width: 22, height: 22, borderRadius: 999, cursor: 'pointer', border: '1.5px solid #E5E7EB', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }} title="Custom">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
        <input type="color" value={value || '#4F46E5'} onChange={(e) => onChange(e.target.value)} style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }} />
      </label>
    </div>
  );
}

function AlignSeg({ value, onChange }) {
  return (
    <div style={segWrap}>
      {['left', 'center', 'right'].map((a) => <button key={a} type="button" onClick={() => onChange(a)} style={seg(value === a)}>{a}</button>)}
    </div>
  );
}

function HeaderInspector({ header, patch }) {
  async function uploadLogo(file) {
    if (!file || !file.type?.startsWith('image/')) return;
    try {
      const url = await uploadEmailLogoAsset(file, { orgKey: 'designer' });
      patch({ logo: url, display: 'logo' });
    } catch (err) {
      console.error('[EmailDesigner] header logo upload failed', err);
    }
  }
  async function useZaroLogo() {
    try {
      const url = await ensureDefaultZaroLogoUrl(zaroLogo);
      patch({ logo: url });
    } catch (_) { patch({ logo: zaroLogo }); }
  }
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 14, position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={sectionTitle}>Header</div>

      <div>
        <label style={fieldLabel}>Brand name</label>
        <input style={fieldInput} value={header.brandName || ''} onChange={(e) => patch({ brandName: e.target.value })} />
      </div>

      <div>
        <label style={fieldLabel}>Show</label>
        <div style={segWrap}>
          {[{ k: 'text', label: 'Text' }, { k: 'logo', label: 'Logo' }, { k: 'both', label: 'Both' }].map((o) => <button key={o.k} type="button" onClick={() => patch({ display: o.k })} style={seg(header.display === o.k)}>{o.label}</button>)}
        </div>
      </div>

      <div>
        <label style={fieldLabel}>Logo</label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={useZaroLogo} style={seg(false)}>Use Zaro logo</button>
          <label style={{ ...seg(false), display: 'inline-block' }}>Upload<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadLogo(f); }} /></label>
          {header.logo && <button type="button" onClick={() => patch({ logo: null, display: 'text' })} style={{ ...seg(false), color: '#B91C1C' }}>Remove</button>}
        </div>
      </div>

      <div>
        <label style={fieldLabel}>Alignment</label>
        <AlignSeg value={header.alignment} onChange={(v) => patch({ alignment: v })} />
      </div>

      <div>
        <label style={fieldLabel}>Accent color</label>
        <ColorRow value={header.accentColor} onChange={(v) => patch({ accentColor: v })} />
      </div>

      <div>
        <label style={fieldLabel}>Background</label>
        <div style={segWrap}>
          {[{ k: 'plain', label: 'Plain' }, { k: 'tint', label: 'Soft tint' }, { k: 'gradient', label: 'Gradient' }].map((o) => <button key={o.k} type="button" onClick={() => patch({ background: o.k })} style={seg(header.background === o.k)}>{o.label}</button>)}
        </div>
      </div>
    </div>
  );
}

function BodyStyleInspector({ bodyStyle, patch }) {
  async function uploadImage(file) {
    if (!file || !file.type?.startsWith('image/')) return;
    try {
      const url = await uploadBrandAsset(file, { folder: 'email-body-bg', orgKey: 'designer', resize: { maxDim: 1600, quality: 0.88 } });
      patch({ image: url, background: 'image' });
    } catch (err) {
      console.error('[EmailDesigner] body background upload failed', err);
    }
  }
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 14, position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={sectionTitle}>Body background</div>
      <div>
        <label style={fieldLabel}>Type</label>
        <div style={segWrap}>
          {[{ k: 'plain', label: 'Plain' }, { k: 'color', label: 'Color' }, { k: 'gradient', label: 'Gradient' }, { k: 'image', label: 'Image' }].map((o) => (
            <button key={o.k} type="button" onClick={() => patch({ background: o.k })} style={seg(bodyStyle.background === o.k)}>{o.label}</button>
          ))}
        </div>
      </div>
      {(bodyStyle.background === 'color' || bodyStyle.background === 'gradient') && (
        <div>
          <label style={fieldLabel}>{bodyStyle.background === 'gradient' ? 'Gradient · top' : 'Color'}</label>
          <ColorRow value={bodyStyle.color || '#ffffff'} onChange={(v) => patch({ color: v })} />
        </div>
      )}
      {bodyStyle.background === 'gradient' && (
        <div>
          <label style={fieldLabel}>Gradient · bottom</label>
          <ColorRow value={bodyStyle.gradientTo || '#F1F5F9'} onChange={(v) => patch({ gradientTo: v })} />
        </div>
      )}
      {bodyStyle.background === 'image' && (
        <div>
          <label style={fieldLabel}>Image</label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {bodyStyle.image && <img src={bodyStyle.image} alt="" style={{ width: 48, height: 32, borderRadius: 4, objectFit: 'cover', border: '1px solid #E5E7EB' }} />}
            <label style={seg(false)}>Upload<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadImage(f); }} /></label>
            {bodyStyle.image && <button type="button" onClick={() => patch({ image: null, background: 'plain' })} style={{ ...seg(false), color: '#B91C1C' }}>Remove</button>}
          </div>
          <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 6 }}>Note: most email clients (Gmail desktop, Apple Mail) render this; Outlook desktop falls back to a flat color.</div>
        </div>
      )}
    </div>
  );
}

function GreetingInspector({ greeting, patch }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 14, position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={sectionTitle}>Heading</div>
      <div style={{ fontSize: 11.5, color: '#6B7280' }}>Click the heading on the canvas to edit text directly. Tokens like <code>{`{organization_name}`}</code> are resolved per-recipient.</div>
      <div>
        <label style={fieldLabel}>Color</label>
        <ColorRow value={greeting.color} onChange={(v) => patch({ color: v })} />
      </div>
      <div>
        <label style={fieldLabel}>Alignment</label>
        <AlignSeg value={greeting.align} onChange={(v) => patch({ align: v })} />
      </div>
      <div>
        <label style={fieldLabel}>Size</label>
        <div style={segWrap}>{['small', 'medium', 'large'].map((s) => <button key={s} type="button" onClick={() => patch({ size: s })} style={seg(greeting.size === s)}>{s}</button>)}</div>
      </div>
    </div>
  );
}

function BodyInspector({ paragraph, patch, onMoveUp, onMoveDown, onRemove, canRemove }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 14, position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={sectionTitle}>Paragraph</div>
      <div style={{ fontSize: 11.5, color: '#6B7280' }}>Click the paragraph to edit text directly.</div>
      <div>
        <label style={fieldLabel}>Color</label>
        <ColorRow value={paragraph.color} onChange={(v) => patch({ color: v })} />
      </div>
      <div>
        <label style={fieldLabel}>Alignment</label>
        <AlignSeg value={paragraph.align} onChange={(v) => patch({ align: v })} />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
        <button type="button" onClick={onMoveUp} style={seg(false)}>↑ Move up</button>
        <button type="button" onClick={onMoveDown} style={seg(false)}>↓ Move down</button>
        {canRemove && <button type="button" onClick={onRemove} style={{ ...seg(false), color: '#B91C1C' }}>Remove</button>}
      </div>
    </div>
  );
}

function CredentialsInspector({ enabled, patch }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 14, position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={sectionTitle}>Credentials block</div>
      <div style={{ fontSize: 11.5, color: '#6B7280' }}>Shows the recipient's login email and temporary password. Disabling hides this whole card.</div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
        <input type="checkbox" checked={enabled !== false} onChange={(e) => patch({ enabled: e.target.checked })} style={{ accentColor: '#4F46E5' }} />
        Show credentials block
      </label>
    </div>
  );
}

function ButtonInspector({ button, patch }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 14, position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={sectionTitle}>Button</div>
      <div>
        <label style={fieldLabel}>Label</label>
        <input style={fieldInput} value={button.label || ''} onChange={(e) => patch({ label: e.target.value })} />
      </div>
      <div>
        <label style={fieldLabel}>Color</label>
        <ColorRow value={button.color} onChange={(v) => patch({ color: v })} />
      </div>
      <div>
        <label style={fieldLabel}>Style</label>
        <div style={segWrap}>{['solid', 'outline', 'pill', 'ghost'].map((s) => <button key={s} type="button" onClick={() => patch({ style: s })} style={seg(button.style === s)}>{s}</button>)}</div>
      </div>
      <div>
        <label style={fieldLabel}>Alignment</label>
        <AlignSeg value={button.align} onChange={(v) => patch({ align: v })} />
      </div>
      <div>
        <label style={fieldLabel}>Action (link)</label>
        <input style={fieldInput} value={button.link || ''} onChange={(e) => patch({ link: e.target.value })} placeholder="{login_url}" />
        <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 4 }}>Use <code>{`{login_url}`}</code> for the recipient's workspace, or paste a fixed URL.</div>
      </div>
    </div>
  );
}

function SignatureInspector({ signature, patch }) {
  async function uploadImage(file) {
    if (!file || !file.type?.startsWith('image/')) return;
    try {
      const url = await uploadBrandAsset(file, { folder: 'email-signature', orgKey: 'designer', resize: { maxDim: 256, quality: 0.9 } });
      patch({ image: url });
    } catch (err) {
      console.error('[EmailDesigner] signature image upload failed', err);
    }
  }
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 14, position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={sectionTitle}>Signature</div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
        <input type="checkbox" checked={signature.enabled} onChange={(e) => patch({ enabled: e.target.checked })} style={{ accentColor: '#4F46E5' }} />
        Show signature
      </label>
      {signature.enabled && (
        <>
          <div>
            <label style={fieldLabel}>Name</label>
            <input style={fieldInput} value={signature.name || ''} onChange={(e) => patch({ name: e.target.value })} />
          </div>
          <div>
            <label style={fieldLabel}>Title</label>
            <input style={fieldInput} value={signature.title || ''} onChange={(e) => patch({ title: e.target.value })} />
          </div>
          <div>
            <label style={fieldLabel}>Photo (optional)</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {signature.image && <img src={signature.image} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} />}
              <label style={{ ...seg(false) }}>Upload<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadImage(f); }} /></label>
              {signature.image && <button type="button" onClick={() => patch({ image: null })} style={{ ...seg(false), color: '#B91C1C' }}>Remove</button>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function FooterInspector({ footer, patch }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E5E7EB', borderRadius: 12, padding: 14, position: 'sticky', top: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={sectionTitle}>Footer</div>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
        <input type="checkbox" checked={footer.show} onChange={(e) => patch({ show: e.target.checked })} style={{ accentColor: '#4F46E5' }} />
        Show footer
      </label>
      {footer.show && (
        <>
          <div>
            <label style={fieldLabel}>Footer text</label>
            <input style={fieldInput} value={footer.text || ''} onChange={(e) => patch({ text: e.target.value })} />
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' }}>
            <input type="checkbox" checked={footer.showBadge} onChange={(e) => patch({ showBadge: e.target.checked })} style={{ accentColor: '#4F46E5' }} />
            Show "Powered by Zaro HR" badge
          </label>
        </>
      )}
    </div>
  );
}

/* ── Color helpers ────────────────────────────────────────────── */

function withAlpha(hex, alpha) {
  const m = /^#?([a-fA-F0-9]{6})$/.exec(String(hex || ''));
  if (!m) return hex;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function darken(hex, pct = 0.22) {
  const m = /^#?([a-fA-F0-9]{6})$/.exec(String(hex || ''));
  if (!m) return hex;
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const r = c(parseInt(m[1].slice(0, 2), 16) * (1 - pct));
  const g = c(parseInt(m[1].slice(2, 4), 16) * (1 - pct));
  const b = c(parseInt(m[1].slice(4, 6), 16) * (1 - pct));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}
