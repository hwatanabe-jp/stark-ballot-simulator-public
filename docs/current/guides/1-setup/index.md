# Setup Guides

This section contains optional setup guides for development paths that need
Rust, RISC Zero, or real zkVM execution. For normal local mock development,
start with the root `README.md`: Node.js, Corepack/pnpm, `.env.local`, and
`pnpm dev` are enough.

## Available Guides

### 🇯🇵 [RISC Zero セットアップガイド](./risc0-setup.md)

**Purpose**: Set up RISC Zero zkVM development environment for this repo  
**Contents**:

- Installing the Rust toolchain (1.91.1)
- Installing cargo-risczero (3.0.5) and toolchain
- Building the zkVM host/guest in this repository
- Troubleshooting common setup issues

## Quick Start Order

1. **Default local mock flow**: follow the root `README.md` quick start.
2. **Real zkVM / Rust work only**: set up the RISC Zero environment
   ([risc0-setup.md](./risc0-setup.md)).

## Related Sections

- After setup, proceed to [Development Guides](../2-development/)
- For deployment, see [Deployment Guides](../3-deployment/)
