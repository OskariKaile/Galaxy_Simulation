// ============================================================
// controls.js
// First-person free-flight controls.
//   WASD          — translate
//   Space / Ctrl  — up / down
//   Shift         — boost  ×8
//   +/-           — cruise speed up/down
//   Mouse         — look (pointer-locked on canvas click)
// ============================================================

import * as THREE from 'three';

export class FlightControls {
  constructor(camera, domElement) {
    this.camera = camera;
    this.dom = domElement;

    // Internal Euler used to drive the camera quaternion.
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._euler.setFromQuaternion(camera.quaternion);

    // Movement state
    this.keys = Object.create(null);
    this.velocity = new THREE.Vector3();

    // Speed config (units = parsecs per second)
    this.cruise = 5;       // base cruise speed
    this.cruiseMin = 0.2;
    this.cruiseMax = 800;
    this.boostFactor = 8;

    // Look config
    this.lookSensitivity = 0.0022;

    // Bind handlers
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp   = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onCanvasClick = this._onCanvasClick.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
    this._onWheel = this._onWheel.bind(this);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup',   this._onKeyUp);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    this.dom.addEventListener('wheel', this._onWheel, { passive: false });

    // We use a separate click hookup that the app can also use
    // for picking. The app installs its own click handler too;
    // we expose this one specifically for pointer lock.
    this._lockOnNextClick = true;
    this.dom.addEventListener('mousedown', this._onCanvasClick);

    this.locked = false;
    this.onCruiseChange = null;

    // Fly-to state
    this._flying = false;
    this._flyTarget = null;
    this.onFlyDone = null;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup',   this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    this.dom.removeEventListener('wheel', this._onWheel);
    this.dom.removeEventListener('mousedown', this._onCanvasClick);
  }

  _onKeyDown(e) {
    // Ignore typing in inputs
    if (e.target instanceof HTMLInputElement) return;

    this.keys[e.code] = true;

    // Speed adjustment
    if (e.code === 'Equal' || e.code === 'NumpadAdd') {
      this.setCruise(this.cruise * 1.4);
    } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
      this.setCruise(this.cruise / 1.4);
    }
  }
  _onKeyUp(e) { this.keys[e.code] = false; }

  _onMouseMove(e) {
    if (!this.locked) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    this._euler.y -= dx * this.lookSensitivity;
    this._euler.x -= dy * this.lookSensitivity;
    // Clamp pitch to avoid flipping
    const halfPi = Math.PI / 2 - 0.001;
    this._euler.x = Math.max(-halfPi, Math.min(halfPi, this._euler.x));
    this.camera.quaternion.setFromEuler(this._euler);
  }

  _onCanvasClick() {
    // The picking handler in main.js looks at e.target etc.;
    // we just request pointer lock if we're not already locked.
    if (!this.locked && this._lockOnNextClick) {
      this.dom.requestPointerLock?.();
    }
  }

  _onPointerLockChange() {
    this.locked = document.pointerLockElement === this.dom;
  }

  _onWheel(e) {
    // Mousewheel adjusts cruise speed.
    e.preventDefault();
    const dir = e.deltaY > 0 ? -1 : 1;
    this.setCruise(this.cruise * (dir > 0 ? 1.2 : 1 / 1.2));
  }

  setCruise(v) {
    this.cruise = Math.max(this.cruiseMin, Math.min(this.cruiseMax, v));
    this.onCruiseChange?.(this.cruise, this.currentSpeedMultiplier());
  }

  currentSpeedMultiplier() {
    return this.keys['ShiftLeft'] || this.keys['ShiftRight'] ? this.boostFactor : 1;
  }

  /** Smoothly fly the camera to a target position + quaternion. */
  flyTo(targetPos, targetQuat) {
    this._flyTarget = { pos: targetPos.clone(), quat: targetQuat.clone() };
    this._flying = true;
    this.velocity.set(0, 0, 0);
  }

  /** Move the camera according to current input state. */
  update(dt) {
    if (this._flying) {
      const t = 1 - Math.exp(-dt * 2.5);
      this.camera.position.lerp(this._flyTarget.pos, t);
      this.camera.quaternion.slerp(this._flyTarget.quat, t);
      if (this.camera.position.distanceTo(this._flyTarget.pos) < 0.005) {
        this.camera.position.copy(this._flyTarget.pos);
        this.camera.quaternion.copy(this._flyTarget.quat);
        this._flying = false;
        this.onFlyDone?.();
      }
      return;
    }

    // Build a local direction vector from key state.
    const fwd   = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
    const right = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
    const up    = (this.keys['Space'] ? 1 : 0)
                 - ((this.keys['ControlLeft'] || this.keys['ControlRight']) ? 1 : 0);

    const boost = this.currentSpeedMultiplier();
    const speed = this.cruise * boost;

    if (fwd || right || up) {
      // Forward in camera local frame
      const dir = new THREE.Vector3(right, 0, -fwd);
      dir.applyQuaternion(this.camera.quaternion);
      dir.y += up;       // world-up vertical strafe — feels nicer than head-up
      if (dir.lengthSq() > 0) dir.normalize();

      // Smooth-ish acceleration toward target velocity
      this.velocity.lerp(dir.multiplyScalar(speed), 1 - Math.exp(-dt * 6));
    } else {
      // Decelerate
      this.velocity.multiplyScalar(Math.exp(-dt * 4));
    }

    this.camera.position.addScaledVector(this.velocity, dt);
  }

  exitLock() {
    document.exitPointerLock?.();
  }
}
