// The C runtime stamp (`/FAILIFMISMATCH:"RuntimeLibrary=..."`) lives in the
// STL's <yvals.h>. Light headers such as <utility> never reach it; <new> does,
// through <exception>, as HarfBuzz's headers did in ghosttea #88.
#include <new>

extern "C" int ghosttea_vt_crt_witness(int value) {
  int* const cell = new (std::nothrow) int(value);
  const int result = cell != nullptr ? *cell : -1;
  delete cell;
  return result;
}
