// SHA-256 hashes of every version of a project-owned harness file that VCM has
// shipped. The installer upgrades an installed copy that still matches one of
// these instead of keeping it as project-modified. Append the new hash whenever
// the template changes; harness-templates-sync tests fail until it is listed.
export const PROJECT_OWNED_SHIPPED_SHA256: Readonly<Record<string, readonly string[]>> = {
  ".ai/tools/generate-module-index": [
    "432fc89448bd26c9504b4bfee93ae2306d0cf01e8f00a946189c3c8148f615f7",
    "96f5763d107e6d95cb605bb5b949e4c40b0715ba3e5bacd9554dfb7f98c332f3",
    "06b9fcc6da0635f6a53a72f68e0ec1934b1bc4037df386e93d8190004c21b1bb",
    "711753b3e4c9afa3198e0ae150d8b686dcb0b1110e4208c60686dcac249c5b6e",
    // 0.9.0, first Node release.
    "a46742b988a3153b26f144db137364fa4be258e79411ebdd2d8b5a8df1566fd0"
  ],
  ".ai/tools/generate-public-surface": [
    "08eb2f5a8df6e5db0bc7385f23f19a572ff586124623a985588842a77ce6ffa3",
    "a4b177f780335962cfccab8de3254456351f9a97ff308d238b5725c7dcb5105e",
    "f8d3a49b0b055302bc9f780b869fe9e8e04b67decdce79b92d0b62b1d911a15e",
    // 0.9.0, first Node release.
    "f495196c8dee8a692e853ab6d756487e27d00e9014f263896fae3d8d36900d91"
  ]
};
