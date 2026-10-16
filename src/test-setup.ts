// Tests see pi as orqi runs it: named orqi, reading the project's .orqi/. pi
// decides that once, at module load, from PI_PACKAGE_DIR (src/pi-package.ts),
// so it is set here, before any test file imports pi.
import { join } from "node:path";
import { piPackageDir } from "./pi-package.ts";

const root = join(import.meta.dir, "..");
process.env.PI_PACKAGE_DIR = piPackageDir(root, root);
