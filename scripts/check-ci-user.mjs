import assert from 'node:assert/strict'

assert.notEqual(process.platform, 'win32', 'Windows CI must use the ordinary-user PowerShell runner')
assert.equal(typeof process.getuid, 'function')
assert.notEqual(process.getuid(), 0, 'CI package commands must not run as root')
console.log(`CI package commands run with uid=${process.getuid()}`)
