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

// Video-mode-only selectors. Verified live against labs.google/flow on
// 2026-04-19. The mock fixture test/mock-flow-video.html mirrors these
// for hermetic tests.
const video = {
  // Tab inside the mode popover that switches Flow to video mode.
  // Flow renders the tab text as "videocamVideo" (Material icon + label);
  // has-text("Video") matches the "Video" substring.
  videoModeTab: 'button.flow_tab_slider_trigger:has-text("Video")',

  // Video models Flow currently exposes in the model dropdown (under the
  // prompt input when in video mode). Only the three "normal" variants are
  // listed here — the "[Lower Priority]" tiers exist but we skip them for
  // the default random pick since they're throttled. Callers can still pass
  // one explicitly via --model.
  modelNames: [
    'Veo 3.1 - Lite',
    'Veo 3.1 - Fast',
    'Veo 3.1 - Quality',
  ],

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
  // "downloadDownload" (icon + label). This downloads the selected clip;
  // for multi-clip extended scenes we may need to select the last clip
  // first — the exact "download the whole stitched scene" path is still
  // best-effort.
  downloadSceneButton: 'button:has-text("downloadDownload")',
};

module.exports = { common, image, video };
