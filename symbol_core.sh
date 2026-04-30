#!/bin/sh
file=dist.js
if [ ! -e $file ]; then
    npm run build
fi

sed -i '1i const use = globalThis[Symbol.for("cjs.internal.use")];' "$file"
sed -i 's/import\.meta\.use/use/g' "$file"
