import { fireEvent, render, screen } from '@testing-library/react-native';
import { concertView, huddleMock } from '../test-utils/fixtures';

let mockHuddle: ReturnType<typeof huddleMock>;
jest.mock('../src/lib/huddle', () => ({ useHuddle: () => mockHuddle }));
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useLocalSearchParams: () => ({ id: 'cy' }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Member from '../src/app/member/[id]';
import Session from '../src/app/session';

describe('session screen', () => {
  test('shows who needs attention, honestly worded, plus the group and the big buttons', async () => {
    const { view } = concertView('ana');
    mockHuddle = huddleMock(view);
    await render(<Session />);
    expect(screen.getByText('Concert')).toBeTruthy();
    expect(screen.getByText('Cy missed a check-in — unreachable, not confirmed in danger')).toBeTruthy();
    expect(screen.getByText(/Nobody has said they are on it yet/)).toBeTruthy();
    expect(screen.getByText("I'm okay")).toBeTruthy();
    expect(screen.getByText('Hold for help')).toBeTruthy();
    expect(screen.getByText('Bea')).toBeTruthy();
    expect(screen.getByText(/End-to-end encrypted/)).toBeTruthy();
  });

  test('tells the user when this phone is still waiting for the group key', async () => {
    const { view } = concertView('bea');
    mockHuddle = huddleMock(view, { encryptionReady: false });
    await render(<Session />);
    expect(screen.getByText(/Waiting for a friend’s phone to share the group key/)).toBeTruthy();
  });

  test('tapping "I\'m okay" checks in', async () => {
    const { view } = concertView('ana');
    mockHuddle = huddleMock(view);
    await render(<Session />);
    fireEvent.press(screen.getByText("I'm okay"));
    expect(mockHuddle.checkIn).toHaveBeenCalled();
  });
});

describe("a friend's screen", () => {
  test('shows known / unknown / next steps for someone who went quiet', async () => {
    const { view } = concertView('bea');
    mockHuddle = huddleMock(view);
    await render(<Member />);
    expect(screen.getByText('What we know')).toBeTruthy();
    expect(screen.getByText("What we don't know")).toBeTruthy();
    expect(screen.getByText(/dead battery, no signal/)).toBeTruthy();
    expect(screen.getByText("I'm on it")).toBeTruthy();
  });

  test('only the host sees "Remove"', async () => {
    mockHuddle = huddleMock(concertView('bea').view);
    await render(<Member />);
    expect(screen.queryByText(/Remove Cy from the huddle/)).toBeNull();
    mockHuddle = huddleMock(concertView('ana').view);
    await render(<Member />);
    expect(screen.getByText('Remove Cy from the huddle')).toBeTruthy();
  });
});
