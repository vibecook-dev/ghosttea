// Any C++ standard header stamps this object with the C runtime it was compiled
// for (`/FAILIFMISMATCH:"RuntimeLibrary=..."`); <utility> is among the lightest.
#include <utility>

extern "C" int ghosttea_vt_crt_witness(int value) {
  return std::exchange(value, value + 1);
}
