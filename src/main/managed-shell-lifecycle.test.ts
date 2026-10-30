import { describe, expect, it, vi } from 'vitest'
import { ManagedShellLifecycle } from './managed-shell-lifecycle'

const event = (sequence: number, phase: string, binding = 'test-launch') =>
  `\x1b]777;orca-shell-lifecycle;${binding};${sequence};${phase}\x07`

describe('managed shell lifecycle', () => {
  it('distinguishes a prompt from a childless builtin and a restored prompt', () => {
    const lifecycle = new ManagedShellLifecycle('test-launch')
    lifecycle.accept(event(1, 'prompt'))
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'prompt' })
    lifecycle.accept(event(2, 'running'))
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'running' })
    lifecycle.accept(event(3, 'prompt'))
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'prompt' })
  })

  it('strips private events across every split without hiding ordinary output', () => {
    const input = `before${event(1, 'prompt')}after`
    for (let split = 0; split <= input.length; split++) {
      const lifecycle = new ManagedShellLifecycle('test-launch')
      expect(lifecycle.accept(input.slice(0, split)) + lifecycle.accept(input.slice(split))).toBe(
        'beforeafter'
      )
      expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'prompt' })
    }
  })

  it('never promotes raw OSC133, foreign launches, or reordered events to prompt', () => {
    const lifecycle = new ManagedShellLifecycle('test-launch')
    lifecycle.accept('\x1b]133;A\x07\x1b]133;B\x07')
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
    lifecycle.accept(event(1, 'prompt', 'other-launch'))
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
    lifecycle.accept(event(2, 'prompt'))
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
    lifecycle.accept(event(1, 'prompt'))
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
  })

  it('revokes prompt on input, children, unavailable inspection and a raced observation', () => {
    const lifecycle = new ManagedShellLifecycle('test-launch')
    lifecycle.accept(event(1, 'prompt'))
    expect(lifecycle.observe('children')).toMatchObject({ phase: 'unknown', reason: 'children' })
    expect(lifecycle.observe('unverifiable')).toMatchObject({ phase: 'unknown' })
    const before = lifecycle.generation
    lifecycle.invalidateInput()
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown', reason: 'input' })
    lifecycle.accept(event(2, 'prompt'))
    expect(lifecycle.observe('no-children', before)).toMatchObject({
      phase: 'unknown',
      reason: 'generation-changed'
    })
  })

  it('expires retained evidence without refreshing its age on read', () => {
    vi.useFakeTimers()
    try {
      const lifecycle = new ManagedShellLifecycle('test-launch')
      lifecycle.accept(event(1, 'prompt'))
      vi.advanceTimersByTime(30_001)
      expect(lifecycle.observe('no-children')).toMatchObject({
        phase: 'unknown',
        reason: 'stale',
        signalAgeMs: 30_001
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('revokes a retained prompt while a new private event is incomplete', () => {
    const lifecycle = new ManagedShellLifecycle('test-launch')
    lifecycle.accept(event(1, 'prompt'))
    const next = event(2, 'running')
    lifecycle.accept(next.slice(0, -1))
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
    lifecycle.accept(next.slice(-1))
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'running' })
  })

  it('bounds and suppresses oversized private events before recovering', () => {
    const lifecycle = new ManagedShellLifecycle('test-launch')
    expect(lifecycle.accept(`\x1b]777;orca-shell-lifecycle;${'x'.repeat(10_000)}`)).toBe('')
    expect(lifecycle.accept('more-private-data\x07public')).toBe('public')
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
  })
  it('does not let a delayed prompt alone undo input invalidation', () => {
    const lifecycle = new ManagedShellLifecycle('test-launch')
    lifecycle.invalidateInput()
    lifecycle.accept(event(1, 'prompt'))
    expect(lifecycle.observe('no-children')).toMatchObject({ phase: 'unknown' })
    lifecycle.accept(event(2, 'running'))
    lifecycle.accept(event(3, 'prompt'))
    expect(lifecycle.observe('no-children')).toMatchObject({
      phase: 'prompt',
      confidence: 'cooperative'
    })
  })
})
