# Photon VS Code Extension — Premium UI Improvement Plan

> Analysis combining photon-website design language with current extension UI
> Generated: August 30, 2026

---

## 🎨 Design Language Analysis (from photon-website)

### **Color System**

| Token | Website Value | Extension Current | Recommendation |
|-------|--------------|-------------------|----------------|
| Background | `#07070A` (void) | `#0a0a0d` | Align to website `#07070A` |
| Surface | `#0E0E12` (ink) | `#121216` | Use `#0E0E12` for cards |
| Border | `rgba(255,255,255,0.07)` | `#212129` | Use subtle white borders |
| Primary Red | `#FF2D2D` | `#e5493f` | Brighten to `#FF2D2D` |
| Primary Orange | `#FF6B2D` | N/A | Add to palette |
| Primary Amber | `#FFC02E` | `#e0a23a` | Brighten to `#FFC02E` |
| Success | N/A | `#33b46e` | Add emerald `#10B981` |
| Text Primary | `#ECECF0` | `#e6e5ec` | Align to `#ECECF0` |
| Text Secondary | `rgba(255,255,255,0.6)` | `#9796a5` | Use alpha-based text |
| Text Tertiary | `rgba(255,255,255,0.4)` | `#666574` | Use alpha-based text |

### **Typography**

| Use | Website Font | Extension Current | Recommendation |
|-----|-------------|-------------------|----------------|
| Display | Bricolage Grotesque | N/A | Use for headings (optional) |
| Body | Instrument Sans | `-apple-system, system-ui` | Keep system fonts for perf |
| Mono | JetBrains Mono | SFMono, JetBrains Mono | Already aligned ✅ |
| Brand | Manrope (800 weight) | System font | Use for "Photon" logo only |

### **Signature Design Elements**

1. **Gradient Text** — `linear-gradient(92deg, #FF2D2D 0%, #FF6B2D 46%, #FFC02E 100%)`
2. **Glass Morphism** — `rgba(20,20,23,0.62)` + `backdrop-filter: blur(16px)`
3. **Card Glow** — Gradient border on hover (`linear-gradient(135deg, rgba(255,45,45,.5), rgba(255,192,46,.35))`)
4. **Hover Lift** — `translateY(-3px)` + `box-shadow: 0 16px 48px rgba(0,0,0,.4)`
5. **Pill/Chip Style** — `border-radius: 9999px` for badges and tags
6. **Subtle Animations** — `cubic-bezier(.16,1,.3,1)` easing for smooth motion

---

## 🚀 Implementation Plan

### **Priority 1: Brand Identity & Color Alignment**

#### 1.1 Update Color Tokens
```css
:root {
  /* Align with website */
  --void: #07070A;
  --ink: #0E0E12;
  --line: rgba(255, 255, 255, 0.07);
  
  /* Brand gradient colors */
  --photon-red: #FF2D2D;
  --photon-orange: #FF6B2D;
  --photon-amber: #FFC02E;
  
  /* Gradient for text and accents */
  --grad-primary: linear-gradient(92deg, #FF2D2D 0%, #FF6B2D 46%, #FFC02E 100%);
  
  /* Updated accent */
  --ok: #10B981; /* Emerald for success */
}
```

#### 1.2 Gradient Text Utility
```css
.grad-text {
  background: var(--grad-primary);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

---

### **Priority 2: Hero/Empty State Redesign**

#### 2.1 New Hero Layout
- **Branded greeting** with gradient "Photon" text
- **Animated orbital logo** (simplified for performance)
- **Mode-specific suggestion cards** with icons
- **Keyboard shortcut hints**

#### 2.2 Suggestion Card Design
```css
.suggestion-card {
  background: rgba(14, 14, 18, 0.62);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 16px;
  padding: 16px;
  transition: all 0.45s cubic-bezier(.22,1,.36,1);
}

.suggestion-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4), 
              0 0 24px rgba(255, 45, 45, 0.08);
  border-color: rgba(255, 107, 45, 0.18);
}
```

---

### **Priority 3: Message List Premium Upgrade**

#### 3.1 Avatar System
Add role indicators to messages:
```css
.msg-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  flex-shrink: 0;
}

.msg-avatar.user {
  background: var(--space-600);
  /* User icon or initials */
}

.msg-avatar.assistant {
  background: var(--grad-primary);
  /* Photon atom SVG */
}
```

#### 3.2 Assistant Message Cards
```css
.msg.assistant .msg-body {
  background: rgba(14, 14, 18, 0.62);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 16px;
  padding: 12px 16px;
}

.msg.assistant .msg-body:hover {
  border-color: rgba(255, 255, 255, 0.12);
}
```

#### 3.3 Message Actions (Hover)
```css
.msg-actions {
  opacity: 0;
  transition: opacity 0.2s;
  display: flex;
  gap: 4px;
}

.msg:hover .msg-actions {
  opacity: 1;
}

.msg-action-btn {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  transition: all 0.15s;
}

.msg-action-btn:hover {
  background: var(--space-700);
  border-color: var(--line);
  color: var(--text);
}
```

---

### **Priority 4: Composer Premium Polish**

#### 4.1 Attach Button Redesign
Replace `+` with paperclip icon:
```css
.attach-btn {
  /* Keep existing styles */
}

.attach-btn svg {
  /* Paperclip icon */
}
```

#### 4.2 Drag-and-Drop Overlay
```css
.composer.dragging::after {
  content: "Drop files here";
  position: absolute;
  inset: 0;
  background: rgba(7, 7, 10, 0.9);
  backdrop-filter: blur(8px);
  border: 2px dashed var(--photon-red);
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--text);
  z-index: 10;
}
```

#### 4.3 Image Thumbnail Previews
```css
.attach-chip.image {
  padding: 4px;
}

.attach-thumbnail {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  object-fit: cover;
}
```

#### 4.4 Focused State Enhancement
```css
.input-wrap:focus-within {
  border-color: var(--photon-red);
  box-shadow: 0 0 0 3px rgba(255, 45, 45, 0.1);
}
```

---

### **Priority 5: Context Meter Refinement**

#### 5.1 Collapsible Meter
```css
.context-meter {
  transition: all 0.3s;
}

.context-meter.collapsed {
  height: 20px;
  overflow: hidden;
}

.context-meter:hover {
  /* Expand on hover */
}
```

#### 5.2 Gradient Progress Bar
```css
.meter-fill {
  background: var(--grad-primary);
  /* Instead of solid red */
}

.meter-fill.low {
  background: var(--ok); /* Green for < 50% */
}

.meter-fill.medium {
  background: var(--photon-amber); /* Amber for 50-80% */
}

.meter-fill.high {
  background: var(--photon-red); /* Red for > 80% */
}
```

---

### **Priority 6: Tool Cards Enhancement**

#### 6.1 Tool Type Color Coding
```css
.tool-card.read-only {
  border-left: 3px solid var(--ok); /* Green for read tools */
}

.tool-card.write {
  border-left: 3px solid var(--photon-amber); /* Amber for write tools */
}

.tool-card.execute {
  border-left: 3px solid var(--photon-red); /* Red for command tools */
}
```

#### 6.2 Tool Result Preview
```css
.tool-preview {
  font-size: 11px;
  color: var(--text-faint);
  font-family: var(--mono);
}
```

---

### **Priority 7: Header Streamlining**

#### 7.1 Single-Row Layout (Optional)
Consider collapsing to single row on smaller viewports:
```css
@media (max-width: 600px) {
  .header-bottom {
    flex-wrap: wrap;
  }
  
  .model-picker {
    order: -1;
    width: 100%;
  }
}
```

#### 7.2 Custom Model Picker
Replace native `<select>` with custom dropdown:
```css
.model-picker-dropdown {
  background: var(--space-800);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  max-height: 320px;
  overflow-y: auto;
}

.model-option {
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  transition: background 0.15s;
}

.model-option:hover {
  background: var(--space-700);
}

.model-option.selected {
  background: var(--space-600);
}
```

---

### **Priority 8: Micro-Interactions & Polish**

#### 8.1 Button Press Effect
```css
.btn:active,
.suggestion-card:active {
  transform: scale(0.97);
}
```

#### 8.2 Smooth Transitions
```css
/* Add to all interactive elements */
transition: all 0.2s cubic-bezier(.16,1,.3,1);
```

#### 8.3 Focus Ring Update
```css
*:focus-visible {
  outline: 2px solid var(--photon-red);
  outline-offset: 2px;
  border-radius: 4px;
}
```

---

### **Priority 9: Code Block Improvements**

#### 9.1 Syntax Highlighting
Integrate a lightweight highlighter (e.g., `highlight.js` with minimal bundle):
```css
.code-block pre code {
  /* Syntax highlighting styles */
}

.code-block .keyword { color: #c678dd; }
.code-block .string { color: #98c379; }
.code-block .comment { color: #5c6370; }
```

#### 9.2 Line Numbers (Toggleable)
```css
.code-block.line-numbers pre {
  counter-reset: line;
}

.code-block.line-numbers pre code .line::before {
  counter-increment: line;
  content: counter(line);
  display: inline-block;
  width: 3em;
  margin-right: 1em;
  text-align: right;
  color: var(--text-faint);
}
```

---

### **Priority 10: Accessibility Enhancements**

#### 10.1 ARIA Labels
```html
<button class="icon-btn" aria-label="Open settings">
  <GearIcon />
</button>

<div class="msg" role="article" aria-label="Assistant message">
  <!-- content -->
</div>
```

#### 10.2 Screen Reader Announcements
```html
<div aria-live="polite" class="sr-only">
  {statusMessage}
</div>
```

#### 10.3 Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 📋 Implementation Checklist

### Phase 1: Quick Wins (1-2 days)
- [ ] Update color tokens to match website
- [ ] Add gradient text utility class
- [ ] Replace attach `+` with paperclip icon
- [ ] Add message hover actions (copy, regenerate)
- [ ] Update focus ring styles

### Phase 2: Core Premium (3-5 days)
- [ ] Redesign Hero/empty state
- [ ] Add message avatars/role indicators
- [ ] Implement glassmorphic assistant message cards
- [ ] Add drag-and-drop visual feedback
- [ ] Enhance composer focused state

### Phase 3: Advanced Polish (5-7 days)
- [ ] Custom model picker dropdown
- [ ] Tool card color coding by type
- [ ] Code block syntax highlighting
- [ ] Context meter collapsible behavior
- [ ] Image thumbnail previews

### Phase 4: Accessibility & perf (2-3 days)
- [ ] Add ARIA labels throughout
- [ ] Implement reduced motion support
- [ ] Screen reader announcements
- [ ] Keyboard navigation audit

---

## 🎯 Expected Impact

| Metric | Before | After (Estimated) |
|--------|--------|-------------------|
| First impression | Functional | Premium |
| Brand consistency | Partial | Full alignment |
| User delight | Low | High |
| Accessibility score | ~70 | 95+ |
| Time to first action | Medium | Low |

---

## 🔗 Reference

- **Website:** `photon-website/index.html`
- **Current CSS:** `webview-ui/src/theme/photon.css`
- **Brand colors:** See Color System table above
- **Design tokens:** `--grad-primary`, `--void`, `--ink`, `--line`

---

*This document serves as the master plan for making Photon's VS Code extension UI feel as premium as the marketing website while maintaining performance and accessibility.*
