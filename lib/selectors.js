// Single source of CSS/Playwright selectors for the labs.google/flow UI.
// When Google ships a UI change, this file is the only place to update.
// For tests against test/mock-flow.html, the fixture mirrors these selectors.
//
// Last verified against real Flow DOM: 2026-04-13.

module.exports = {
  // Prompt input: contentEditable div where user types the prompt.
  // Real Flow uses a div[role="textbox"], not a <textarea>.
  promptInput: '[role="textbox"]',

  // Button that submits the prompt. Real Flow's submit button renders a
  // Material icon glyph "arrow_forward" + text "Create", yielding the
  // combined textContent "arrow_forwardCreate". We match the full string
  // to disambiguate from a sidebar "add_2Create" button that opens the
  // asset-search dialog instead of submitting (same text="Create" fuzzy
  // match previously landed on the wrong button).
  generateButton: 'text=arrow_forwardCreate',

  // Mode switcher: the compact button in the prompt bar whose label
  // contains "crop_16_9" (aspect ratio glyph). Clicking it opens a
  // popover with Image/Video/Frames/Ingredients tabs.
  modeButton: 'button:has-text("crop_16_9")',

  // The "Image" tab inside the mode popover. Flow defaults to Video —
  // we click this to switch to Image generation (Nano Banana / Imagen).
  imageModeTab: 'button.flow_tab_slider_trigger:has-text("Image")',

  // The count-per-prompt tab inside the same popover as imageModeTab.
  // Takes a number: `countTab(1)` → button for "x1". flow_tab_slider_trigger
  // is also used by the Image/Video mode tabs, but only the count tabs have
  // text starting with "x<digit>" so :has-text is unambiguous here.
  countTab: (n) => `button.flow_tab_slider_trigger:has-text("x${n}")`,

  // The three image models Flow currently exposes. Order doesn't matter;
  // we pick randomly per job. When Google adds/removes a model, edit here.
  modelNames: ['Nano Banana Pro', 'Nano Banana 2', 'Imagen 4'],

  // Dropdown trigger inside the mode popover that opens the model list.
  // It's a button containing the currently selected model's name. We have
  // to exclude the closed prompt-bar modeButton (which also contains the
  // model name) via :not(:has-text("crop_16_9")) — only the prompt-bar
  // button carries the aspect-ratio glyph.
  modelDropdown: [
    'button:has-text("Nano Banana Pro"):not(:has-text("crop_16_9"))',
    'button:has-text("Nano Banana 2"):not(:has-text("crop_16_9"))',
    'button:has-text("Imagen 4"):not(:has-text("crop_16_9"))',
  ].join(', '),

  // Option inside the opened model dropdown. Takes a model name.
  // Tries common ARIA roles plus <li> as fallback.
  modelOption: (name) =>
    `[role="option"]:has-text("${name}"), [role="menuitem"]:has-text("${name}"), li:has-text("${name}")`,

  // All <img> elements on the page. We detect "new image" by diffing the
  // set of image src URLs before and after submission — NOT by alt text,
  // because Flow sets alt to the prompt (truncated), so the alt isn't
  // predictable.
  allImages: 'img',

  // Elements whose presence indicates known error states.
  captchaFrame: 'iframe[src*="recaptcha"]',
  quotaBanner: 'text=/no credits/i',
};
