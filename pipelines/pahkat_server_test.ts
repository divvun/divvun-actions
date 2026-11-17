import { equal, throws } from "node:assert/strict"
import YAML from "yaml"

Deno.env.set("BUILDKITE", "true")
Deno.env.set("BUILDKITE_REPO", "git@github.com:divvun/pahkat-next.git")
Deno.env.delete("BUILDKITE_PLUGINS")

const { pinArgoKustomizeImage } = await import("~/util/k8s-config.ts")
const { pushedDigest } = await import("~/pipelines/pahkat-server.ts")

const IMAGE = "ghcr.io/divvun/pahkat-server"
const PATH = "apps/services/pahkat-server-app.yaml"
const COMMIT = "9325eeee505eefeb7bf74650388070a828b78a79"
const DIGEST =
  "sha256:0d3f479537f0d8d369e8ac6ad9207679931838d308544dee26a4455156bbac33"
const NEXT_DIGEST =
  "sha256:28566d178f7d6c4f38b37cbe6e079a25173148f2fca90d45b97c384dd3e486c8"

function application(image: string): string {
  return `# The Pahkat server.
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: pahkat-server
  namespace: argocd
spec:
  project: default
  source:
    repoURL: git@github.com:divvun/pahkat-next.git
    targetRevision: main
    path: deploy
    kustomize:
      images:
        - ${image}
  destination:
    server: https://kubernetes.default.svc
    # A comment the update keeps.
    namespace: pahkat
`
}

function images(source: string): unknown {
  return YAML.parse(source).spec.source.kustomize.images
}

const pin = (source: string, digest: string) =>
  pinArgoKustomizeImage(source, {
    imageName: IMAGE,
    digest,
    applicationPath: PATH,
  })

Deno.test("an update pins a tag-pinned server image by its digest and changes nothing else", () => {
  const before = application(`${IMAGE}:sha-${COMMIT}`)
  const after = pin(before, DIGEST)
  equal(after, application(`${IMAGE}@${DIGEST}`))
})

Deno.test("an update to a digest-pinned server image keeps it a digest", () => {
  const after = pin(application(`${IMAGE}@${DIGEST}`), NEXT_DIGEST)
  equal(
    JSON.stringify(images(after)),
    JSON.stringify([`${IMAGE}@${NEXT_DIGEST}`]),
  )
})

Deno.test("an override's name in the manifests is kept", () => {
  const after = pin(application(`${IMAGE}=${IMAGE}:sha-${COMMIT}`), DIGEST)
  equal(
    JSON.stringify(images(after)),
    JSON.stringify([`${IMAGE}=${IMAGE}@${DIGEST}`]),
  )
})

Deno.test("an update never writes a tag, or anything but a sha256 digest", () => {
  const before = application(`${IMAGE}@${DIGEST}`)
  for (
    const digest of [
      `sha-${COMMIT}`,
      "latest",
      "",
      DIGEST.slice(0, -1),
      DIGEST.toUpperCase(),
      `sha512:${"0".repeat(128)}`,
      `${DIGEST}\n`,
      `sha-${COMMIT}@${DIGEST}`,
    ]
  ) {
    throws(() => pin(before, digest), /not a sha256 digest/)
  }
})

Deno.test("an update refuses an Application without exactly one override for the image", () => {
  throws(
    () => pin(application("ghcr.io/divvun/other:sha-1"), DIGEST),
    /found 0/,
  )
  const twice = application(`${IMAGE}:sha-${COMMIT}`).replace(
    "      images:\n",
    `      images:\n        - ${IMAGE}:sha-0\n`,
  )
  throws(() => pin(twice, DIGEST), /found 2/)
})

Deno.test("the digest is the one docker push reports for the tag", () => {
  const output = [
    "The push refers to repository [ghcr.io/divvun/pahkat-server]",
    "f3018d1baa63: Pushed",
    "d1421c413e8c: Layer already exists",
    `sha-${COMMIT}: digest: ${DIGEST} size: 856`,
    "",
  ].join("\n")
  equal(pushedDigest(output, `sha-${COMMIT}`), DIGEST)
})

Deno.test("a push that reports no digest, or two, for the tag is refused", () => {
  throws(
    () => pushedDigest(`sha-0: digest: ${DIGEST} size: 856`, `sha-${COMMIT}`),
    /0 digests/,
  )
  throws(
    () =>
      pushedDigest(
        `sha-${COMMIT}: digest: ${DIGEST} size: 856\nsha-${COMMIT}: digest: ${NEXT_DIGEST} size: 856`,
        `sha-${COMMIT}`,
      ),
    /2 digests/,
  )
})
