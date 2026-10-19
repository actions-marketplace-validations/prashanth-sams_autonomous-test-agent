# Publishing a release

For maintainers. Publishing one GitHub release ships the agent in every form
people use:

| People use | What gets published | By |
| --- | --- | --- |
| The GitHub Action | The `vX.Y.Z` tag, and the `v1` tag moves to it | You (the tag) and [update-major-tag.yml](../.github/workflows/update-major-tag.yml) (`v1`) |
| The Docker image | `ghcr.io/prashanth-sams/autonomous-test-agent:X.Y.Z`, plus `X.Y`, `X` and `latest` | [docker-publish.yml](../.github/workflows/docker-publish.yml) |
| The CLI, from source | The `vX.Y.Z` tag | You |

> [!IMPORTANT]
> Both workflows run when a release is **published**. Pushing a tag on its own
> publishes nothing.

**Contents:** [Release steps](#release-steps) ·
[First release with Docker](#first-release-with-docker-make-the-image-public) ·
[Prereleases](#prereleases) ·
[Upgrading Playwright](#upgrading-playwright) ·
[Docker Hub](#optional-publish-to-docker-hub-too) ·
[Troubleshooting](#if-something-goes-wrong) ·
[Publishing by hand](#publishing-by-hand)

---

## Release steps

Pick the version with [semantic versioning](https://semver.org): `1.0.8` for
fixes, `1.1.0` for new features, `2.0.0` for breaking changes. A new major
version starts new floating tags (`v2` and `:2`), and people pinned to `v1`
and `:1` stay on 1.x.

1. **Start from a green `main`.** The **QA Agent** check passes, and so does
   **Docker image** when the changes touched the image.
2. **Update `CHANGELOG.md`.** Rename `## [Unreleased]` to
   `## [X.Y.Z] - YYYY-MM-DD`, and update the compare links at the bottom.
3. **Bump `version`** in the root `package.json` to `X.Y.Z`.
4. **Merge** those changes to `main`.
5. **Publish the release.** On GitHub, go to **Releases → Draft a new
   release**:
   - **Choose a tag:** type `vX.Y.Z` and pick **Create new tag on publish**,
     with `main` as the target.
   - **Title:** `vX.Y.Z`.
   - **Notes:** paste this version's section from `CHANGELOG.md`.
   - Click **Publish release**.

   Or, with the [GitHub CLI](https://cli.github.com):

   ```bash
   gh release create vX.Y.Z --target main --title vX.Y.Z --notes-file notes.md
   ```

   Use the `vX.Y.Z` format, for example `v1.1.0`. The major-tag workflow
   ignores any other format, and the Docker workflow needs a semantic version
   in the tag to name the image.
6. **Watch the workflows** on the **Actions** tab. Each takes a few minutes:
   - **Docker image** runs **Build and test**, which builds the image and runs
     it against the demo shop, then **Publish**, which builds it for
     `linux/amd64` and `linux/arm64` and pushes it. If the test fails, nothing
     is pushed.
   - **Update major version tag** moves `v1` to the new release.
7. **Check the published image:**

   ```bash
   docker run --rm ghcr.io/prashanth-sams/autonomous-test-agent:X.Y.Z --help
   docker buildx imagetools inspect ghcr.io/prashanth-sams/autonomous-test-agent:X.Y.Z
   ```

   The second command should list `linux/amd64` and `linux/arm64`. The
   package page is
   <https://github.com/users/prashanth-sams/packages/container/package/autonomous-test-agent>.

## First release with Docker: make the image public

The first image comes with the first release that includes the
[Dockerfile](../Dockerfile). Earlier tags have no image. Merge the Docker
changes and publish that release close together, because the README tells
people to pull the image.

You don't need to set anything up before that release: the workflow pushes
with the repository's built-in `GITHUB_TOKEN`. But GitHub creates every new
package as **private**, so after that first publish nobody else can pull the
image. Make it public, once:

1. Open the package page above. You can also reach it from your GitHub profile
   under **Packages**.
2. Click **Package settings**, in the sidebar on the right.
3. Under **Danger Zone**, click **Change visibility**, choose **Public**, type
   the package name and confirm.

> [!WARNING]
> A public package can't be made private again.

On the same settings page, check that the package is connected to this
repository. The image's `org.opencontainers.image.source` label connects it,
which lets this repository's workflow keep pushing new versions.

## Prereleases

Tick **Set as a pre-release** when you publish. The image is then pushed under
its own version only, for example `1.1.0-rc.1`. `X.Y`, `X`, `latest` and the
Action's `v1` stay on the last full release.

## Upgrading Playwright

The image gets its browsers from the base image in the
[Dockerfile](../Dockerfile), and gets the Playwright library from
`package-lock.json`. Upgrade both together:

1. Update `playwright` in `executors/web-playwright/package.json`, then run
   `npm install` to update the lockfile.
2. Set `PLAYWRIGHT_IMAGE` in the Dockerfile to the same version, for example
   `mcr.microsoft.com/playwright:v1.64.0-noble`.

If you forget step 2, the build stops with:

```text
Playwright 1.64.0 has no browsers in this base image. Set PLAYWRIGHT_IMAGE to mcr.microsoft.com/playwright:v1.64.0-noble.
```

The **Docker image** check on the pull request catches this before a release
does.

## Optional: publish to Docker Hub too

The workflow also pushes to Docker Hub once these are set:

1. On Docker Hub, create the repository, for example
   `<your-user>/autonomous-test-agent`, and an access token with **Read &
   Write** permission.
2. On GitHub, go to **Settings → Secrets and variables → Actions** and add:
   - the variable `DOCKERHUB_IMAGE`, set to `<your-user>/autonomous-test-agent`
   - the secret `DOCKERHUB_USERNAME`, your Docker Hub username
   - the secret `DOCKERHUB_TOKEN`, the access token

From the next release on, the same tags are pushed to both registries.

## If something goes wrong

| Symptom | What to do |
| --- | --- |
| **Build and test** failed | Nothing was pushed. If the failure looks temporary (a network error, for example), click **Re-run failed jobs**. If the code is at fault, fix it on `main` and publish a new patch release. Don't move a published tag: people may already use it. |
| **Publish** failed with `denied` or `permission_denied` | The package exists but isn't connected to this repository, which happens when it was first pushed from a laptop. In **Package settings → Manage Actions access**, add this repository with the **Write** role, then re-run the job. |
| `docker pull` says `denied` or `unauthorized` for everyone but you | The package is still private. See [First release with Docker](#first-release-with-docker-make-the-image-public). |
| The workflows didn't start | Check that the release was published, not left as a draft, and that it was created by a person. A release created by another workflow's `GITHUB_TOKEN` doesn't trigger workflows. |

## Publishing by hand

Use this only when the workflow can't run. Run it from a clean checkout of the
release tag:

```bash
git checkout vX.Y.Z

# A personal access token (classic) with the write:packages scope
echo "$GHCR_TOKEN" | docker login ghcr.io -u prashanth-sams --password-stdin

docker buildx build --platform linux/amd64,linux/arm64 \
  --build-arg VERSION=X.Y.Z \
  -t ghcr.io/prashanth-sams/autonomous-test-agent:X.Y.Z \
  -t ghcr.io/prashanth-sams/autonomous-test-agent:X.Y \
  -t ghcr.io/prashanth-sams/autonomous-test-agent:X \
  -t ghcr.io/prashanth-sams/autonomous-test-agent:latest \
  --push .
```

If `buildx` reports that the current driver doesn't support multi-platform
builds, create a builder that does, once: `docker buildx create --use`.
