// Single source of CSS/Playwright selectors for the labs.google/flow UI.
// When Google ships a UI change, this file is the only place to update.
// For tests against test/mock-flow.html, the fixture mirrors these selectors.
//
// Last verified against real Flow DOM: 2026-04-13.

module.exports = {
  // Prompt input: contentEditable div where user types the prompt.
  // Real Flow uses a div[role="textbox"], not a <textarea>.
  promptInput: '[role="textbox"]',

  // Button that submits the prompt. Real Flow button text includes a
  // Material icon ("arrow_forward") + "Create". Playwright's text= selector
  // matches partial text content. Only used with page.waitForSelector/click.
  generateButton: 'text=Create',

  // Mode switcher: the compact button in the prompt bar whose label
  // contains "crop_16_9" (aspect ratio glyph). Clicking it opens a
  // popover with Image/Video/Frames/Ingredients tabs.
  modeButton: 'button:has-text("crop_16_9")',

  // The "Image" tab inside the mode popover. Flow defaults to Video —
  // we click this to switch to Image generation (Nano Banana / Imagen).
  imageModeTab: 'button.flow_tab_slider_trigger:has-text("Image")',

  // All <img> elements on the page. We detect "new image" by diffing the
  // set of image src URLs before and after submission — NOT by alt text,
  // because Flow sets alt to the prompt (truncated), so the alt isn't
  // predictable.
  allImages: 'img',

  // Elements whose presence indicates known error states.
  captchaFrame: 'iframe[src*="recaptcha"]',
  quotaBanner: 'text=/no credits/i',
};
