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
  generateButton: 'text=arrow_forwardCreate',

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

// Video-mode-only selectors. Most are best-effort starters that MUST be
// verified live per docs/superpowers/specs/2026-04-18-flow-video-cli-design.md §9
// before they'll work against real labs.google/flow. The mock fixture
// test/mock-flow-video.html mirrors these for hermetic tests.
const video = {
  // Tab inside the mode popover that switches Flow to video mode.
  // Live-verify — placeholder pattern mirrors the image tab shape.
  videoModeTab: 'button.flow_tab_slider_trigger:has-text("Video")',

  // Video models Flow currently exposes. Live-verify exact names.
  modelNames: ['veo-3', 'veo-3-fast', 'veo-2'],

  // Aspect-ratio options inside the mode popover. Live-verify.
  aspectOption: (ratio) =>
    `button.flow_tab_slider_trigger:has-text("${ratio}")`,

  // All <video> elements on the page. Used for src-diff completion detection,
  // mirror of image.allImages.
  allVideos: 'video',

  // Extend button that appears next to each generated clip.
  extendButton: 'button:has-text("Extend")',

  // Entry point for the Frames-to-video upload UI.
  framesEntry: 'button:has-text("Frames")',

  // Thumbnail preview that appears after a successful frame upload.
  framePreview: '[data-frame-preview]',

  // Button that triggers the stitched scene download.
  downloadSceneButton: 'button:has-text("Download scene")',
};

module.exports = { common, image, video };
