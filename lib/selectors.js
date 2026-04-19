// Single source of CSS/Playwright selectors for the labs.google/flow UI.
// When Google ships a UI change, this file is the only place to update.
// For tests against test/mock-flow.html and test/mock-flow-video.html, the
// fixtures mirror these selectors.
//
// Last verified against real Flow DOM: 2026-04-13.

// Selectors used by both image and video flows.
const common = {
  // Prompt input: contentEditable div where user types the prompt.
  promptInput: '[role="textbox"]',

  // Generate button. Real Flow renders "arrow_forward" glyph + "Create".
  // In extend mode there are TWO such buttons (one disabled leftover from
  // scene creation, one active for the extend prompt), so exclude the
  // disabled variant to always pick the active one.
  generateButton: 'button:has-text("arrow_forwardCreate"):not([disabled])',

  // Mode switcher in the prompt bar. Label contains "crop_16_9" glyph.
  modeButton: 'button:has-text("crop_16_9")',

  // Error-state canaries.
  captchaFrame: 'iframe[src*="recaptcha"]',
  quotaBanner: 'text=/no credits/i',
};

// Image-mode-only selectors.
const image = {
  // "Image" tab inside the mode popover.
  imageModeTab: 'button.flow_tab_slider_trigger:has-text("Image")',

  // Count-per-prompt tab inside the mode popover. countTab(1) → "x1".
  countTab: (n) => `button.flow_tab_slider_trigger:has-text("x${n}")`,

  // Image models Flow currently exposes.
  modelNames: ['Nano Banana Pro', 'Nano Banana 2', 'Imagen 4'],

  // Dropdown trigger inside the mode popover.
  modelDropdown: [
    'button:has-text("Nano Banana Pro"):not(:has-text("crop_16_9"))',
    'button:has-text("Nano Banana 2"):not(:has-text("crop_16_9"))',
    'button:has-text("Imagen 4"):not(:has-text("crop_16_9"))',
  ].join(', '),

  // Option inside the opened model dropdown.
  modelOption: (name) =>
    `[role="option"]:has-text("${name}"), [role="menuitem"]:has-text("${name}"), li:has-text("${name}")`,

  // All <img> elements on the page.
  allImages: 'img',
};

// Video-mode-only selectors. Verified live against labs.google/flow on
// 2026-04-19. The mock fixture test/mock-flow-video.html mirrors these
// for hermetic tests.
const video = {
  // Tab inside the mode popover that switches Flow to video mode.
  // Flow renders the tab text as "videocamVideo" (Material icon + label);
  // has-text("Video") matches the "Video" substring.
  videoModeTab: 'button.flow_tab_slider_trigger:has-text("Video")',

  // Video models Flow currently exposes in the model dropdown. Only the
  // three "normal" variants are listed here — the "[Lower Priority]"
  // throttled tiers exist but we skip them from the default pool. Callers
  // can still pass one explicitly via --model.
  modelNames: [
    'Veo 3.1 - Lite',
    'Veo 3.1 - Fast',
    'Veo 3.1 - Quality',
  ],

  // Trigger that opens the video model dropdown. Visible both inside the
  // mode popover and on a clip's detail view. The button's textContent
  // looks like "Veo 3.1 - Qualityarrow_drop_down" — matching both "Veo"
  // and "arrow_drop_down" disambiguates it from unrelated dropdowns.
  videoModelDropdownTrigger:
    'button:has-text("Veo"):has-text("arrow_drop_down")',

  // A specific option inside the opened model dropdown. Flow renders each
  // option as a [role="menuitem"] with a Material icon prefix; matching
  // has-text on the name is enough.
  videoModelOption: (name) => `[role="menuitem"]:has-text("${name}")`,

  // Aspect-ratio options inside the mode popover. In video mode only "16:9"
  // and "9:16" are offered (4:3 / 1:1 / 3:4 are image-mode-only).
  aspectOption: (ratio) =>
    `button.flow_tab_slider_trigger:has-text("${ratio}")`,

  // All <video> elements on the page. Used for src-diff completion detection,
  // mirror of image.allImages.
  allVideos: 'video',

  // Extend button appears on a rendered clip's detail view. Flow's text is
  // "keyboard_double_arrow_rightExtend" (icon + label).
  extendButton: 'button:has-text("Extend")',

  // Frames-to-video sub-mode tab inside the mode popover. Flow's text is
  // "crop_freeFrames" (icon + label). Note: this tab is only visible AFTER
  // the Video tab has been clicked — in image mode the popover hides it.
  framesTab: 'button.flow_tab_slider_trigger:has-text("Frames")',

  // Thumbnail preview that appears after a successful frame upload.
  // Still best-effort — update once we've exercised the Frames-to-video
  // flow end-to-end against real Flow.
  framePreview: '[data-frame-preview]',

  // Download button on a rendered clip's detail view. Flow's text is
  // "downloadDownload" (icon + label). Clicking it opens a resolution
  // picker MODAL with four options — 720p/1080p download the stitched
  // multi-clip scene as one mp4; 4K costs 50 extra credits; 270p is a GIF.
  downloadSceneButton: 'button:has-text("downloadDownload")',

  // Resolution option inside the Download modal. Safe keys: '720p' and
  // '1080p' only. '4K' is excluded because Flow's 4K option costs 50
  // additional credits (one misclick = 50 wasted credits). '270p' is
  // an animated GIF, not what we want.
  downloadQualityOption: (key) => {
    if (key !== '720p' && key !== '1080p') {
      throw new Error(`downloadQualityOption: refusing to match "${key}" (only 720p/1080p allowed — 4K costs 50 credits, 270p is a GIF)`);
    }
    // Match the exact resolution substring, then require "Upscaled" or
    // "Original" so we never accidentally match a 4K button that
    // happens to contain an embedded "1080p" somewhere in its label.
    return `button:has-text("${key}Original Size"), button:has-text("${key}Upscaled"), button:has-text("${key}")`;
  },
};

module.exports = { common, image, video };
