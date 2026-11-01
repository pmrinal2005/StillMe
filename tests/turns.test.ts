import { describe, expect, it } from 'vitest'
import { TurnTracker, materialChange } from '@/lib/turns'

describe('Conversation Brake — materialChange', () => {
  it('ignores identical text and pure extension of the same sentence', () => {
    expect(materialChange('Do you want', 'Do you want')).toBeNull()
    expect(materialChange('Do you want some tea', 'Do you want some tea with milk')).toBeNull()
  })
  it('flags a negation added after an affirmative partial', () => {
    expect(materialChange('We can go to the park', 'We can not go to the park')).toBe('negation')
    expect(materialChange('Let us meet', 'Let us meet, actually wait')).toBe('negation')
  })
  it('flags changed or added numbers/dates', () => {
    expect(materialChange('Meet at 3 on Tuesday', 'Meet at 4 on Tuesday')).toBe('number_or_date')
    expect(materialChange('Meet on Tuesday', 'Meet on Wednesday')).toBe('number_or_date')
    expect(materialChange('Can we meet', 'Can we meet tomorrow')).toBe('number_or_date')
  })
  it('flags a topic change', () => {
    expect(materialChange('How was the doctor visit today', 'Did you see the football game last night')).not.toBeNull()
  })
  it('flags a new question appended to a statement', () => {
    expect(materialChange('I made dinner.', 'I made dinner. Are you hungry right now?')).toBe('topic_change')
  })
})

describe('TurnTracker', () => {
  it('REPLACES partial revisions instead of appending duplicates', async () => {
    const t = new TurnTracker('conv1')
    await t.apply({ turnId: 0, text: 'Do you', endOfTurn: false })
    await t.apply({ turnId: 0, text: 'Do you want', endOfTurn: false })
    const { turn } = await t.apply({ turnId: 0, text: 'Do you want tea?', endOfTurn: true })
    expect(t.all()).toHaveLength(1)
    expect(turn.text).toBe('Do you want tea?')
    expect(turn.revision).toBe(2)
  })
  it('no churn for identical revisions; late partials after final are ignored', async () => {
    const t = new TurnTracker('conv1')
    await t.apply({ turnId: 0, text: 'Hi', endOfTurn: true })
    expect((await t.apply({ turnId: 0, text: 'Hi', endOfTurn: true })).changed).toBe(false)
    const late = await t.apply({ turnId: 0, text: 'Hi the', endOfTurn: false })
    expect(late.changed).toBe(false)
    expect(t.get(0)!.text).toBe('Hi')
  })
  it('bounds memory to maxTurns', async () => {
    const t = new TurnTracker('c', 0, 3)
    for (let i = 0; i < 6; i++) await t.apply({ turnId: i, text: `turn ${i}`, endOfTurn: true })
    expect(t.all().map((x) => x.turnId)).toEqual([3, 4, 5])
  })
  it('staleness: valid when unchanged; invalid after material revision, new turn, or new generation', async () => {
    const t = new TurnTracker('conv1')
    const { turn } = await t.apply({ turnId: 0, text: 'Shall we go Tuesday', endOfTurn: false })
    const ref = t.ref(turn)
    expect(t.staleness(ref, turn.text)).toBeNull()
    await t.apply({ turnId: 0, text: 'Shall we go Tuesday or', endOfTurn: false })
    expect(t.staleness(ref, turn.text)).toBeNull() // non-material extension
    await t.apply({ turnId: 0, text: 'Shall we go Tuesday or not', endOfTurn: false })
    expect(t.staleness(ref, turn.text)).toBe('negation')

    const t2 = new TurnTracker('conv1')
    const a = await t2.apply({ turnId: 0, text: 'Want tea', endOfTurn: true })
    const r2 = t2.ref(a.turn)
    await t2.apply({ turnId: 1, text: 'Or maybe some coffee instead', endOfTurn: false })
    expect(t2.staleness(r2, 'Want tea')).toBe('new_turn')
    t2.bumpGeneration()
    expect(t2.staleness(r2, 'Want tea')).toBe('new_turn')
  })
})
