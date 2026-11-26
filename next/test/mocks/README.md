Each op in `OPS` has one mock here, `<op>.js`, named as the op is registered.
Its default export is `{ argv, ctx }`: the arguments as typed, which the op's `args` parse, and the context of the run on mock data (`next/test/op-schemas.test.js`).
