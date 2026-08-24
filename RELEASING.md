# Releasing

This repository has one public branch: `main`.

## One-time npm setup

npm currently needs the package to exist before its Trusted Publisher can be configured. Publish `0.1.0` once from a clean checkout with your npm account:

```bash
npm ci
npm run check
npm publish --access public
```

Then open the package settings on npmjs.com and add a GitHub Actions Trusted Publisher:

- Organization or user: `alexshpunt`
- Repository: `pi-session-surgery`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`

Do not add an npm token to this repository or its GitHub secrets.

## Later releases

Update the version, commit it, and push a matching tag:

```bash
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "release: pi-session-surgery v$(node -p \"require('./package.json').version\")"
git tag -a "v$(node -p \"require('./package.json').version\")" -m "pi-session-surgery v$(node -p \"require('./package.json').version\")"
git push origin main --follow-tags
```

The `release.yml` workflow checks the tag, tests the package, audits production dependencies, scans the repository for secrets, checks the tarball, publishes to npm with provenance, and creates the GitHub release.
