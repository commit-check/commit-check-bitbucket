const neostandard = require('neostandard')

module.exports = [
  ...neostandard({ env: ['node', 'jest'] }),
  {
    rules: {
      'no-console': 'warn',
      'prefer-const': 'error',
      'no-unused-vars': 'error'
    }
  }
]
