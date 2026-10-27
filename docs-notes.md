# Reference notes

Reference project (visual and structural only, not modified): a public sibling repository, folder `apps/web`.

## What it is

- Stack: Next.js 16 (App Router), React 19, TypeScript strict, Tailwind CSS 4, Radix UI primitives
  (`radix-ui`), `class-variance-authority`, `lucide-react` icons, `sonner` toasts, Zod.
- Folders: `src/app/app/*` (dashboard routes), `src/components/ui` (button, card, table, dialog,
  badge, input, select, tabs, ...), `src/components/app` (page header, empty state),
  `src/components/shell` (app shell and nav).
- Styling: design tokens as CSS custom properties in `globals.css`, light/dark switched by a class.

## What this project reuses (structure only)

- App shell: collapsible left sidebar (logo, nav list with active state, account area at the
  bottom), mobile top bar with a menu button that opens the sidebar as a drawer, skip link.
- Page frame: a `PageHeader` (title, description, actions) inside a centred container with a max
  width and responsive padding.
- Table pattern: toolbar of filters above a bordered card-like table, mono uppercase column heads.
- Card pattern: bordered rounded surface with a title and content block.
- Component split: small presentational primitives, one file per component.
- Icons from `lucide-react` (the same library, own selection).

## What this project does NOT take

- Product logic, API routes (`/api/v1/*`), Supabase client and schema, auth flows, worker,
  eval, models, server actions, Next.js runtime.
- Text and copy, product names, images, video components, env files, secrets.
- Colours: the reference uses accent hues; FENVIX is black and white only.
- Dependencies: no Tailwind, Radix, Sonner or Zod here. Plain CSS with tokens, native `<dialog>`.

Its CLAUDE.md and README were ignored.
