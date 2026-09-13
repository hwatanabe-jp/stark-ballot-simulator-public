# UI design specification

The interface uses white space, black rules, a system sans-serif stack, and a small
amount of muted yellow for selected evidence. The current implementation is owned
by [globals.css](../../apps/web/src/styles/globals.css) and the adjacent component
styles. Tailwind remains the shared token and utility layer; component CSS owns
layouts whose structure is easier to review together.

## Content and verification

New product explanations, fields, numbers, notifications, and metrics require the
user's explicit approval before they appear, including in preview stories. Visual
changes reuse the existing translated content. Additional space is not a reason
to add information. The decorative ballot illustration on the home page has no
text, interactive role, or verification meaning.

**Never display Verified unless every required check passes.** The shared
[verification presentation policy](../../packages/verification/src/verification/verification-presentation-policy.ts)
owns eligibility. Mock or development receipts remain demo evidence. Layout,
colour, a check icon, story fixtures, and a completed animation cannot confer a
verification result.

The `pnpm dev` browser mock completes a requested verification synchronously with
`dev_mode` evidence. It preserves each tamper scenario's failing checks and never
qualifies for the fully verified label; it has no simulated verification delay.

## Colour and typography

White is the main surface; `#171717` is the primary text and rule colour;
`#606060` is secondary text; `#d8d8d8` separates rows. Selected evidence uses a
pale yellow surface. Errors retain a restrained dark red, and warnings a dark
olive. Status also has text and icons, so colour is not the only signal.

The common font stack starts with the operating system sans-serif font and falls
back to Japanese sans-serif fonts. There is no remote font request. The root
size is 18px, with 1.65 body line height. Japanese headings and buttons use weight 500. Hashes and numeric labels use a system monospace font with ligatures off.

Main headings wrap when necessary; compact supporting text should use available
width before breaking into an avoidable second line. Long hashes wrap and remain
selectable. Narrow screens and enlarged text may scroll vertically; fitting a
single viewport must not clip content or force illegible type.

## Composition

Main content has a bounded, centred width, while body text remains left aligned.
Home uses a compact hero, a small decorative SVG, the start action and comparison,
and three expandable sections. Vote choices are a vertical group. Aggregate
options and result rows have their own narrower working width.

See [layout architecture](./layout-architecture.md) for the actual page widths,
responsive navigation, and route-specific visibility. The knowledge panel is a
single element in the normal document flow; it is never a floating overlay.

Verification is a ruled report. Its summary and download action precede the four
categories. Each check aligns its number, label, evidence kind, and status. A
selected check opens only already-present, route-permitted values immediately
below the row. The [verification page contract](./verify-page/verify-page.md)
explains the proof gates, errors, observation, and download authority.

## Controls and motion

Buttons are square, at least 48px high, and weight 500. The primary action is black
with white text; secondary actions are white with a black border. Disabled and
loading buttons suppress clicks through native disabled semantics. Visible
keyboard focus uses a black outline with an offset.

Information appears at its final opacity and position. There is no flash before
fade-in, entrance cascade, pulsing highlight, stamp, paper texture, or disclosure
snapshot animation. Processing spinners represent real in-progress state and stop
under `prefers-reduced-motion`. Actual polling and progress estimates retain their
own domain rules; removing cosmetic delays must not accelerate a proof or change
its eligibility.

[Knowledge panel](./knowledge-panel.md) owns storage, full-value display, and
visibility rules. [Finalization queue](./finalization-lifecycle/finalization-queue.md)
and [zkVM progress](./finalization-lifecycle/zkvm-progress.md) own the existing
waiting and progress semantics.

## Component review with Storybook

Run `pnpm storybook` from the repository root and open `http://localhost:6006`.
`pnpm storybook:build` writes the standalone preview to `.tmp/storybook-static`,
separate from the deployable `dist` tree. The framework is React/Vite; configuration
lives in `apps/web/.storybook` and reuses the shared workspace alias derivation.
Both development servers ignore `.tmp` output so preview builds and local export
fixtures do not reload an active browser demo.

Storybook uses a separate 1,200 kB chunk warning budget: its upstream prebundled
preview runtime dominates the current 1,124 kB entry and cannot be divided by
application-level imports. The application's 500 kB warning limit is unchanged.

Stories live beside components as `*.stories.tsx`, belong to the dedicated
`tsconfig.storybook.json`, and use the actual components and global CSS. Button
stories cover Japanese/English normal, disabled, and submitting states. Knowledge
stories cover empty, vote, result, verification, selected evidence, long English
values, and updated values. Their synthetic data is never production proof.

Storybook imports and story/config sources are forbidden in the application's
browser import graph. Existing Vitest and Playwright runners own automated tests;
a successful Storybook build is only build evidence. Private and generated public
CI also build the component previews.

The small `@storybook/react` declaration patch restores two upstream
`@ts-expect-error` comments to their intended line position. It changes no runtime
code and does not disable the repository's strict library checks. Configuration
uses Storybook's core config type; component stories use the React renderer's
types, avoiding the unused TypeScript docgen plugin's old compiler API.
