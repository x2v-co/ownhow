# Deploy the OwnHow landing page

The public site is the static `site/` directory. It needs no build step, npm
dependencies, JavaScript, external fonts, CDNs, or trackers. Its canonical URL is
`https://ownhow.dev/`. Documentation links point to this repository on GitHub.

## Create the Cloudflare Pages project

1. Sign in to the Cloudflare account that will manage both Pages and `ownhow.dev`.
2. Create a **Pages Direct Upload** project named **ownhow** under **Workers &
   Pages**. Use the Pages upload flow rather than connecting the Git repository;
   GitHub Actions will upload the existing files. Upload the contents of `site/`
   for the first deployment, with `index.html` at the upload root.
3. Alternatively, from this repository on a machine with Node.js 22 or newer,
   create and deploy the project using Wrangler:

   ```sh
   npx wrangler@4 login
   npx wrangler@4 pages project create ownhow --production-branch=main
   npx wrangler@4 pages deploy site --project-name=ownhow --branch=main
   ```

4. Ensure the project's production branch is **main** (set it in the creation
   prompt or project settings if using the dashboard). Confirm the production
   deployment works at the `*.pages.dev` hostname shown by Cloudflare. Use that
   assigned hostname in the DNS steps below; it is usually `ownhow.pages.dev`.

The upload directory is `site/`; no framework preset or build command is needed.
Cloudflare reads `site/_headers` to apply the security headers to static responses.
See Cloudflare's [Direct Upload guide](https://developers.cloudflare.com/pages/get-started/direct-upload/)
and [header configuration](https://developers.cloudflare.com/pages/configuration/headers/).

## Configure GitHub Actions

1. Create a Cloudflare API token with **Account → Cloudflare Pages → Edit**,
   scoped to the account containing the project. DNS setup is performed separately
   in the dashboard; this deployment token does not need DNS permissions.
2. Copy that account's Account ID from the Cloudflare dashboard.
3. In the GitHub repository, open **Settings → Secrets and variables → Actions**
   and add these repository secrets:

   | Secret | Value |
   | --- | --- |
   | `CLOUDFLARE_API_TOKEN` | The scoped API token |
   | `CLOUDFLARE_ACCOUNT_ID` | The Pages project's Cloudflare account ID |

4. Push a change under `site/` to `main`, or run **Actions → Deploy landing page →
   Run workflow**, selecting `main` for a production deployment.

`.github/workflows/pages.yml` uses `cloudflare/wrangler-action` to run
`pages deploy site --project-name=ownhow`. There is no application build or install
step. If either secret is absent, checkout and deployment are skipped, the job
succeeds, and the job summary explains why. Configured but invalid credentials
still fail so deployment problems remain visible. Wrangler uses the checked-out
branch; a manual run from another branch creates a preview rather than updating
production. Workflow-only and docs-only pushes do not trigger deployment; use the
manual action when needed.

See Cloudflare's [CI deployment guide](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

## Connect `ownhow.dev`

1. Add `ownhow.dev` as a zone in the **same Cloudflare account** as the Pages
   project. Review the imported DNS records, preserving existing mail and other
   service records, then set the domain's nameservers at its registrar to the two
   nameservers assigned by Cloudflare. Wait for the zone to become active.
2. Open **Workers & Pages → ownhow → Custom domains → Set up a domain**, enter
   `ownhow.dev`, and follow the DNS confirmation flow. Associate the domain with
   Pages before adding a CNAME manually.
3. Confirm the resulting apex record is a CNAME with name `@`, targeting the
   project's assigned `*.pages.dev` hostname. Cloudflare handles apex CNAME
   flattening. Resolve any conflicting apex A, AAAA, or CNAME record in the
   dashboard as part of this change.
4. Wait for the Pages custom domain and its managed TLS certificate to become
   active, then visit `https://ownhow.dev/`. The `.dev` domain requires HTTPS.
5. If `www.ownhow.dev` is desired, add it separately under **Custom domains** and
   point its CNAME to the same Pages hostname. Configure a Cloudflare Redirect
   Rule to send `www.ownhow.dev` to `https://ownhow.dev`, preserving path and query.
   The page's canonical and Open Graph URLs already use the apex domain.

An apex Pages domain requires Cloudflare nameservers. For a subdomain using an
external DNS provider, first associate it under Pages **Custom domains**, then add
a CNAME at that DNS provider targeting the assigned Pages hostname. A DNS record
alone does not associate the hostname with the project. See Cloudflare's
[custom domain instructions](https://developers.cloudflare.com/pages/configuration/custom-domains/).

Keep Cloudflare Web Analytics, automatic script injection, and other tracking
features disabled to retain the site's tracker-free behavior.

## Verify an update

Preview locally from the repository root:

```sh
python3 -m http.server 8080 --directory site
```

Open `http://localhost:8080/`. Python's basic server does not apply Cloudflare's
`_headers`; check those on the deployed site:

```sh
curl -I https://ownhow.dev/
curl https://ownhow.dev/robots.txt
```

Confirm the page, favicon, stylesheet, install sections, Chinese section, and
GitHub/documentation links work on desktop and mobile. Check the response for
Content-Security-Policy, X-Content-Type-Options, X-Frame-Options, Referrer-Policy,
Permissions-Policy, and Strict-Transport-Security. The policy permits the local
stylesheet and inline SVG data favicon and blocks scripts, frames, and network
connections. Keep install commands aligned with `README.md` when updating releases.

Run `npm run verify` for the existing CLI syntax checks and test suite. Publishing
the site does not require changes to the CLI package or its release workflow.
