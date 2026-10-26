import { fireEvent, render, screen } from '@testing-library/react-native';

const mockReplace = jest.fn();
const mockNotify = jest.fn(async () => true);
const mockLocation = jest.fn(async () => ({ granted: true }));
const mockStore: Record<string, string> = {};
jest.mock('expo-router', () => ({ router: { replace: (...a: unknown[]) => mockReplace(...a) } }));
jest.mock('../src/lib/device', () => ({ requestNotificationPermission: () => mockNotify() }));
jest.mock('expo-location', () => ({ requestForegroundPermissionsAsync: () => mockLocation() }));
jest.mock('expo-secure-store', () => ({ setItemAsync: async (k: string, v: string) => void (mockStore[k] = v) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import Onboarding, { ONBOARDED_KEY } from '../src/app/onboarding';

test('explains first, asks for permissions only on their own step, then goes to setup', async () => {
  await render(<Onboarding />);
  expect(screen.getByText('Look out for each other')).toBeTruthy();
  expect(screen.getByText(/not an emergency service/)).toBeTruthy();
  expect(mockNotify).not.toHaveBeenCalled();

  fireEvent.press(screen.getByText('Next'));
  expect(await screen.findByText('Notifications')).toBeTruthy();
  fireEvent.press(screen.getByText('Allow notifications'));
  expect(await screen.findByText('Location, only when it helps')).toBeTruthy();
  expect(mockNotify).toHaveBeenCalledTimes(1);

  fireEvent.press(screen.getByText('Not now')); // declining is fine
  expect(mockLocation).not.toHaveBeenCalled();
  expect(await screen.findByText('Bluetooth and microphone')).toBeTruthy();
  fireEvent.press(screen.getByText('Next'));
  expect(await screen.findByText('Private by design')).toBeTruthy();
  expect(screen.getByText('Read the privacy policy')).toBeTruthy();
  fireEvent.press(screen.getByText('Set up my details'));
  await screen.findByText('Private by design');
  await new Promise((r) => setTimeout(r, 0));
  expect(mockStore[ONBOARDED_KEY]).toBe('1');
  expect(mockReplace).toHaveBeenCalledWith('/setup');
});
