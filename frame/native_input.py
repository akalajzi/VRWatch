"""Candidate-only digital HUD actions; ordinary pointer/clicks remain Steam input."""
import ctypes as C
from pathlib import Path
from browser_input import Thumbsticks


class Digital(C.Structure):
    _fields_ = [('active', C.c_bool), ('origin', C.c_uint64),
                ('state', C.c_bool), ('changed', C.c_bool), ('time', C.c_float)]


class NativeInput(Thumbsticks):
    def __init__(self, state):
        super().__init__(state, Path(__file__).parent / 'native-input', 'vrwatch.native-input')
        try:
            get = C.CFUNCTYPE(C.c_int, C.c_char_p, C.POINTER(C.c_uint64))(self.input_functions[2])
            self.read_digital = C.CFUNCTYPE(C.c_int, C.c_uint64, C.POINTER(Digital), C.c_uint32, C.c_uint64)(self.input_functions[5])
            self.digital = {}
            for name in ('navigation', 'tabs'):
                handle = C.c_uint64()
                self.check(get(('/actions/browser/in/' + name).encode(), C.byref(handle)), 'Get HUD action')
                self.digital[name] = handle.value
            self.armed = False
        except Exception:
            self.close()
            raise

    def hud_actions(self, enabled):
        if not enabled:
            self.armed = False
            return []
        actions = []
        held = False
        for name, handle in self.digital.items():
            value = Digital()
            self.check(self.read_digital(handle, C.byref(value), C.sizeof(value), 0), 'Read HUD action')
            held |= value.active and value.state
            if self.armed and value.active and value.state and value.changed:
                actions.append(name)
        if not held:
            self.armed = True
        return actions
