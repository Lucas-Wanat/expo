import * as osascript from '@expo/osascript';
import assert from 'assert';
import chalk from 'chalk';

import { delayAsync, TimeoutError } from '../../../utils/delay';
import { CommandError } from '../../../utils/errors';
import { profile } from '../../../utils/profile';
import { validateUrl } from '../../../utils/url';
import { DeviceManager } from '../DeviceManager';
import {
  getBestBootedSimulatorAsync,
  getBestUnbootedSimulatorAsync,
  getSelectableSimulatorsAsync,
} from './getBestSimulator';
import { isSimulatorInstalledAsync } from './isSimulatorInstalled';
import { promptAppleDeviceAsync } from './promptAppleDevice';
import * as SimControl from './SimControl';
import { ensureSimulatorAppRunningAsync } from './ensureSimulatorAppRunning';
import { BaseResolveDeviceProps } from '../PlatformManager';

const EXPO_GO_BUNDLE_IDENTIFIER = 'host.exp.Exponent';

/**
 * Ensure a simulator is booted and the Simulator app is opened.
 * This is where any timeout related error handling should live.
 */
async function ensureSimulatorOpenAsync(
  { udid, osType }: { udid?: string; osType?: string } = {},
  tryAgain: boolean = true
): Promise<SimControl.SimulatorDevice> {
  // Use a default simulator if none was specified
  if (!udid) {
    // If a simulator is open, side step the entire booting sequence.
    const simulatorOpenedByApp = await getBestBootedSimulatorAsync({ osType });
    if (simulatorOpenedByApp) {
      return simulatorOpenedByApp;
    }

    // Otherwise, find the best possible simulator from user defaults and continue
    udid = await getBestUnbootedSimulatorAsync({ osType });
  }

  const bootedDevice = await profile(SimControl.waitForDeviceToBootAsync)({ udid });

  if (!bootedDevice) {
    // Give it a second chance, this might not be needed but it could potentially lead to a better UX on slower devices.
    if (tryAgain) {
      return await ensureSimulatorOpenAsync({ udid, osType }, false);
    }
    // TODO: We should eliminate all needs for a timeout error, it's bad UX to get an error about the simulator not starting while the user can clearly see it starting on their slow computer.
    throw new TimeoutError(
      `Simulator didn't boot fast enough. Try opening Simulator first, then running your app.`
    );
  }
  return bootedDevice;
}

export class AppleDeviceManager extends DeviceManager<SimControl.SimulatorDevice> {
  static async assertSystemRequirementsAsync() {
    assert(
      await profile(isSimulatorInstalledAsync)(),
      'Unable to verify Xcode and Simulator installation.'
    );
  }

  static async resolveAsync({
    device,
    osType,
    shouldPrompt,
  }: BaseResolveDeviceProps<
    Pick<SimControl.SimulatorDevice, 'udid'>
  > = {}): Promise<AppleDeviceManager> {
    if (shouldPrompt) {
      const devices = await getSelectableSimulatorsAsync({ osType });
      device = await promptAppleDeviceAsync(devices, osType);
    }

    const booted = await ensureSimulatorOpenAsync({ udid: device?.udid, osType });
    return new AppleDeviceManager(booted);
  }

  get name() {
    return this.device.name;
  }

  async getAppVersionAsync(applicationId: string): Promise<string | null> {
    assert(
      applicationId === EXPO_GO_BUNDLE_IDENTIFIER,
      'Only the Expo Go app is supported for version fetching'
    );
    const localPath = await SimControl.getContainerPathAsync({
      udid: this.device.udid,
      bundleIdentifier: applicationId,
    });
    if (!localPath) {
      return null;
    }

    const regex = /Exponent-([0-9.]+).*\.app$/;
    const regexMatch = regex.exec(localPath);
    if (!regexMatch) {
      return null;
    }

    let matched = regexMatch[1];
    // If the value is matched like 1.0.0. then remove the trailing dot.
    if (matched.endsWith('.')) {
      matched = matched.substr(0, matched.length - 1);
    }
    return matched;
  }

  async startAsync(): Promise<SimControl.SimulatorDevice> {
    return ensureSimulatorOpenAsync({ osType: this.device.osType, udid: this.device.udid });
  }

  async launchApplicationIdAsync(applicationId: string) {
    const result = await SimControl.openBundleIdAsync({
      udid: this.device.udid,
      bundleIdentifier: applicationId,
    }).catch((error) => {
      if ('status' in error) {
        return error;
      }
      throw error;
    });
    if (result.status === 0) {
      await this.activateWindowAsync();
    } else {
      let errorMessage = `Couldn't open iOS app with ID "${applicationId}" on device "${this.name}".`;
      if (result.status === 4) {
        errorMessage += `\nThe app might not be installed, try installing it with: ${chalk.bold(
          `expo run:ios -d ${this.device.udid}`
        )}`;
      }
      errorMessage += chalk.gray(`\n${result.stderr}`);
      throw new CommandError(errorMessage);
    }
  }

  async installAppAsync(binaryPath: string) {
    await SimControl.installAsync({
      udid: this.device.udid,
      dir: binaryPath,
    });

    await this.waitForAppInstalledAsync(await this.getApplicationIdFromBundle(binaryPath));
  }

  private async getApplicationIdFromBundle(binaryPath: string): Promise<string> {
    // TODO: Implement...
    return EXPO_GO_BUNDLE_IDENTIFIER;
  }

  private async waitForAppInstalledAsync(applicationId: string): Promise<boolean> {
    if (await this.isAppInstalledAsync(applicationId)) {
      return true;
    } else {
      await delayAsync(100);
      return await this.waitForAppInstalledAsync(applicationId);
    }
  }

  async uninstallAppAsync(applicationId: string) {
    await SimControl.uninstallAsync({
      udid: this.device.udid,
      bundleIdentifier: applicationId,
    });
  }

  async isAppInstalledAsync(applicationId: string) {
    return !!(await SimControl.getContainerPathAsync({
      udid: this.device.udid,
      bundleIdentifier: applicationId,
    }));
  }

  async openUrlAsync(url: string) {
    // Non-compliant URLs will be treated as application identifiers.
    if (!validateUrl(url, { requireProtocol: true })) {
      return await this.launchApplicationIdAsync(url);
    }

    try {
      await SimControl.openUrlAsync({ udid: this.device.udid, url });
    } catch (error) {
      if (error.status === 194) {
        // An error was encountered processing the command (domain=NSOSStatusErrorDomain, code=-10814):
        // The operation couldn’t be completed. (OSStatus error -10814.)
        //
        // This can be thrown when no app conforms to the URI scheme that we attempted to open.
        throw new CommandError(
          'SIMULATOR_CONFORMANCE',
          `Device ${this.device.name} (${this.device.udid}) has no app to handle the URI: ${url}`
        );
      }
      throw error;
    }
  }

  async activateWindowAsync() {
    await ensureSimulatorAppRunningAsync(this.device);
    // TODO: Focus the individual window
    await osascript.execAsync(`tell application "Simulator" to activate`);
  }
}
