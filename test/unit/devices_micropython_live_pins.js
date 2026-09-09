const tap = require('tap');

const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const makeRuntime = () => ({
    constructor: {
        PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
        PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA',
        PERIPHERAL_LIVE_UNAVAILABLE: 'PERIPHERAL_LIVE_UNAVAILABLE',
        PERIPHERAL_LIVE_AVAILABLE: 'PERIPHERAL_LIVE_AVAILABLE'
    },
    emit () {},
    on () {},
    removeListener () {},
    registerPeripheralExtension () {},
    isRealtimeMode: () => true
});

/**
 * A live peripheral whose board is a recorder: every statement handed to
 * execLive is captured instead of sent, so tests can assert the exact
 * python the pin blocks would run.
 * @return {{peripheral: MicroPythonBlePeripheral, commands: Array.<string>}} - the pair.
 */
const makePinPeripheral = () => {
    const peripheral = new MicroPythonBlePeripheral(
        makeRuntime(), 'dev', 'dev', {register: false}
    );
    const commands = [];
    peripheral.execLive = command => {
        commands.push(command);
        return Promise.resolve('');
    };
    return {peripheral, commands};
};

test('re-running "pin mode OUT" + "PWM" recreates the PWM instead of driving a detached pad', async t => {
    const {peripheral, commands} = makePinPeripheral();

    // First green flag.
    await peripheral.setPinMode('13', 'OUTPUT');
    await peripheral.setPwmOutput('13', 512);
    t.same(commands, [
        'p13 = Pin(13)\np13.init(Pin.OUT)\n',
        'pwm13 = PWM(Pin(13), freq=1000, duty=0)\npwm13.duty(int(512))'
    ], 'first run configures the pin, then builds the PWM on it');

    // Second green flag: the mode block re-inits the pin as plain GPIO,
    // which on the ESP32 detaches the pad from the LEDC channel.
    commands.length = 0;
    await peripheral.setPinMode('13', 'OUTPUT');
    await peripheral.setPwmOutput('13', 512);
    t.same(commands, [
        'pwm13.deinit()\np13 = Pin(13)\np13.init(Pin.OUT)\n',
        'pwm13 = PWM(Pin(13), freq=1000, duty=0)\npwm13.duty(int(512))'
    ], 'the PWM is released before the re-init and rebuilt by the next PWM write');
    t.equal(peripheral.hasLiveObject('pwm13'), true, 'PWM tracked again');
    t.end();
});

test('a digital write on a PWM pin takes the pin over, a later PWM write takes it back', async t => {
    const {peripheral, commands} = makePinPeripheral();

    await peripheral.setPwmOutput('4', 300);
    await peripheral.setDigitalOutput('4', '1');
    t.same(commands, [
        'pwm4 = PWM(Pin(4), freq=1000, duty=0)\npwm4.duty(int(300))',
        'pwm4.deinit()\np4 = Pin(4)\np4.init(Pin.OUT)\np4.value(1)'
    ], 'the digital write frees the PWM before configuring the pin');
    t.equal(peripheral.hasLiveObject('pwm4'), false, 'PWM forgotten');

    commands.length = 0;
    await peripheral.setPwmOutput('4', 300);
    t.same(commands, [
        'pwm4 = PWM(Pin(4), freq=1000, duty=0)\npwm4.duty(int(300))'
    ], 'the PWM object is rebuilt, re-attaching the pad');
    t.end();
});

test('servo and analog owners are released the same way, plain re-mode stays a bare init', async t => {
    const {peripheral, commands} = makePinPeripheral();

    await peripheral.setServoOutput('5', 90);
    peripheral._liveObjects.add('adc2');
    peripheral._liveObjects.add('tp2');
    commands.length = 0;

    await peripheral.setPinMode('5', 'INPUT_PULLUP');
    await peripheral.setPinMode('2', 'INPUT');
    t.same(commands, [
        'servo5.deinit()\np5 = Pin(5)\np5.init(Pin.IN, Pin.PULL_UP)\n',
        'p2 = Pin(2)\np2.init(Pin.IN)\n'
    ], 'servo gets deinit()ed, adc/touch are just forgotten');
    t.equal(peripheral.hasLiveObject('servo5'), false, 'servo forgotten');
    t.equal(peripheral.hasLiveObject('adc2'), false, 'adc forgotten');
    t.equal(peripheral.hasLiveObject('tp2'), false, 'touch forgotten');

    // Re-applying the same mode to a plain GPIO pin: no owner to release,
    // the legacy bare init is kept.
    commands.length = 0;
    await peripheral.setPinMode('2', 'INPUT');
    t.same(commands, ['p2.init(Pin.IN)'], 'idempotent mode block');
    t.end();
});
