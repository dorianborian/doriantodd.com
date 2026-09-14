# Moving doriantodd.com from Google Sites to GitHub Pages

Goal: no downtime and no email disruption. The Google Site stays live until the new site is proven,
and every step has a rollback.

## What DNS looks like today (checked 2026-09-13, Namecheap BasicDNS)

| Host | Type | Value | Purpose | Touch? |
|---|---|---|---|---|
| `@` | URL Redirect (shows as A `162.255.119.229`) | `https://www.doriantodd.com` | apex -> www | **Replace** |
| `www` | CNAME | `ghs.googlehosted.com` | Google Sites | **Replace** |
| `@` | MX x5 | `eforward1-5.registrar-servers.com` | Namecheap email forwarding for contact@ | Leave alone |
| `@` | TXT | `v=spf1 include:spf.efwd.registrar-servers.com ~all` | email SPF | Leave alone |
| `@` | TXT x2 | `google-site-verification=...` | Google Search Console | Leave alone |

Screenshot the Namecheap **Advanced DNS** page before changing anything.

## 1. Create the repo and push (10 min)

Name the repository **`dorianborian.github.io`**. A repo with that exact name is served from the root of
`https://dorianborian.github.io`, so you can test the full site before touching DNS. (Any other name
would be served from a subfolder, which breaks root-relative links until the domain is attached.)

```bash
cd C:\Users\doria\dev\doriantodd.com
git remote add origin https://github.com/dorianborian/dorianborian.github.io.git
git push -u origin main
```

Then in the repo: **Settings > Pages > Build and deployment > Source: GitHub Actions**.
Watch **Actions**; the Deploy workflow should go green in about two minutes.

## 2. Verify the domain with GitHub (5 min, prevents takeover)

**GitHub (your account, not the repo) > Settings > Pages > Add a domain > `doriantodd.com`.**
GitHub shows a TXT record. Add it in Namecheap:

| Type | Host | Value |
|---|---|---|
| TXT | `_github-pages-challenge-dorianborian` | *(value GitHub shows)* |

Click **Verify** once it propagates (usually minutes). Leave this record in place permanently.

## 3. Review on the staging URL

Open `https://dorianborian.github.io` and click through: home assembly, parts list, each project,
`/sesame`, `/sesame/kit` (newsletter form), `/FCE`, `/executioner`, `/about`, `/contact`, and a phone.
`npm run check` already ran in CI and confirmed every old URL has a page.

## 4. Lower the TTL (the day before)

In Namecheap, set the TTL on the `www` CNAME to **5 min**. This makes the switch and any rollback quick.

## 5. Switch DNS (the actual cutover, 5 min)

Namecheap > Domain List > doriantodd.com > **Advanced DNS**, under Host Records:

1. Delete the `www` CNAME to `ghs.googlehosted.com`, add:

   | Type | Host | Value | TTL |
   |---|---|---|---|
   | CNAME | `www` | `dorianborian.github.io.` | 5 min |

2. Delete the `@` **URL Redirect** record, add these (GitHub then redirects apex to www over HTTPS,
   which the Namecheap redirect never could):

   | Type | Host | Value |
   |---|---|---|
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | AAAA | `@` | `2606:50c0:8000::153` |
   | AAAA | `@` | `2606:50c0:8001::153` |
   | AAAA | `@` | `2606:50c0:8002::153` |
   | AAAA | `@` | `2606:50c0:8003::153` |

3. Don't touch **Mail Settings** (keep Email Forwarding) or the MX/TXT records.

Then in the repo: **Settings > Pages > Custom domain: `www.doriantodd.com` > Save.**
Wait for the DNS check to pass, then tick **Enforce HTTPS** (the certificate can take up to an hour; the
checkbox is greyed out until it's ready). The custom domain lives in that setting; deploys from
GitHub Actions don't change it (`public/CNAME` is only kept so the build is portable).

Check it:

```bash
nslookup www.doriantodd.com
curl -I https://www.doriantodd.com
curl -I https://doriantodd.com
```

The first should show `dorianborian.github.io`. The second should return `200` with `server: GitHub.com`.
The third should return `301` to `https://www.doriantodd.com/`.

## 6. After it's live

- Send a test email to contact@doriantodd.com and confirm it still forwards.
- Google Search Console: the verification TXT records are unchanged, so the property stays verified.
  Submit `https://www.doriantodd.com/sitemap-index.xml`.
- **Google Sites:** after a week with no issues, open the site in Google Sites > Settings > Custom domains
  and remove `www.doriantodd.com`. Leave the Google Site published at its sites.google.com address for a
  month as a fallback, then unpublish it. Don't delete it: the raw HTML is also archived in
  `migration/archive/`.
- Raise the `www` TTL back to Automatic.

## Rollback

Put back the `www` CNAME to `ghs.googlehosted.com` and the `@` URL Redirect to
`https://www.doriantodd.com`. With a 5 min TTL, most visitors see the old site again within minutes.
Google Sites keeps serving the domain as long as it's still listed under its Custom domains.
