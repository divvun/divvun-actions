import { ok, strictEqual } from "node:assert/strict"
import { globToRegExp } from "@std/path"
import {
  assetFileName,
  assetGlob,
  assetGrepPattern,
  assetPsPattern,
  assetStem,
} from "./asset_name.ts"

const version = "0.1.0-dev.20260915T184109Z+build.6"

Deno.test("release names reserve underscores for fields and normalize x86-64", () => {
  strictEqual(
    assetFileName("divvun-wind", "x86_64-pc-windows-msvc", version, "exe"),
    `divvun-wind_x86-64-pc-windows-msvc_${version}.exe`,
  )
  strictEqual(
    assetStem("libdivvun_runtime", "x86_64-unknown-linux-gnu", version),
    `libdivvun_runtime_x86-64-unknown-linux-gnu_${version}`,
  )
  strictEqual(
    assetStem("outto", "aarch64-apple-darwin", version),
    `outto_aarch64-apple-darwin_${version}`,
  )
})

Deno.test("download matchers accept canonical and existing release names for either input spelling", () => {
  for (const target of ["x86_64-pc-windows-msvc", "x86-64-pc-windows-msvc"]) {
    const regexes = [
      new RegExp(`^${assetGrepPattern("outto", target, "zip")}$`),
      new RegExp(assetPsPattern("outto", target, "zip")),
    ]
    const glob = globToRegExp(assetGlob("outto", target))
    for (
      const stem of [
        `outto_x86-64-pc-windows-msvc_${version}`,
        `outto_x86_64-pc-windows-msvc_${version}`,
        `outto-x86_64-pc-windows-msvc-${version}`,
      ]
    ) {
      for (const regex of regexes) {
        ok(regex.test(`${stem}.zip`), `${regex} rejects ${stem}`)
      }
      ok(glob.test(stem), `glob rejects ${stem}`)
    }
    for (const regex of regexes) {
      ok(!regex.test(`outto_aarch64-apple-darwin_${version}.zip`))
    }
    ok(!glob.test(`outto_aarch64-apple-darwin_${version}`))
  }
})
