#include "node_addon_internal.hpp"
#include <cmath>
#include <limits>

namespace pmjs::addon {
namespace {

struct TileWindow {
  int width, height, x, y, columns, rows;
  bool wrapX, wrapY;
};

std::optional<TileWindow> tileWindow(napi_env env, const std::vector<napi_value>& args,
                                    std::size_t first, std::size_t wrapping) {
  bool array = false;
  check(env, napi_is_array(env, args[0], &array), "cannot inspect tile data");
  if (!array) return std::nullopt;
  std::array<int, 6> geometry;
  for (std::size_t i = 0; i < geometry.size(); ++i) {
    napi_valuetype type;
    check(env, napi_typeof(env, args[first + i], &type), "cannot inspect tile geometry");
    if (type != napi_number) return std::nullopt;
    const double value = asNumber(env, args[first + i]);
    if (!std::isfinite(value) || std::floor(value) != value || std::abs(value) > 1048576)
      return std::nullopt;
    geometry[i] = static_cast<int>(value);
  }
  const auto [width, height, x, y, columns, rows] = geometry;
  if (width <= 0 || height <= 0 || columns < 0 || rows < 0 ||
      std::uint64_t(width) * height > std::numeric_limits<std::uint32_t>::max() ||
      std::int64_t(columns) * rows > 1048576) return std::nullopt;
  return TileWindow{width, height, x, y, columns, rows,
                    asBoolean(env, args[wrapping]), asBoolean(env, args[wrapping + 1])};
}

template<class Visitor>
void visitTileWindow(napi_env env, napi_value data, const TileWindow& window, Visitor visit) {
  const napi_value zero = number(env, 0);
  for (int row = 0; row < window.rows; ++row) {
    napi_handle_scope scope;
    check(env, napi_open_handle_scope(env, &scope), "cannot open tile window scope");
    try {
      int y = window.y + row;
      if (window.wrapY) y = ((y % window.height) + window.height) % window.height;
      for (int column = 0; column < window.columns; ++column) {
        int x = window.x + column;
        if (window.wrapX) x = ((x % window.width) + window.width) % window.width;
        napi_value cell = zero;
        if (x >= 0 && y >= 0 && x < window.width && y < window.height) {
          const auto index = static_cast<std::uint32_t>(std::uint64_t(y) * window.width + x);
          check(env, napi_get_element(env, data, index, &cell), "cannot read tile cell");
          napi_value truth;
          check(env, napi_coerce_to_bool(env, cell, &truth), "cannot inspect tile cell truthiness");
          if (!asBoolean(env, truth)) cell = zero;
        }
        visit(static_cast<std::uint32_t>(row * window.columns + column), cell);
      }
    } catch (...) {
      napi_close_handle_scope(env, scope);
      throw;
    }
    check(env, napi_close_handle_scope(env, scope), "cannot close tile window scope");
  }
}

napi_value readTileWindow(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 9) throw std::invalid_argument("tile window requires data and geometry");
  const auto window = tileWindow(env, args, 1, 7);
  if (!window) return null(env);
  napi_value result;
  check(env, napi_create_array_with_length(env, window->columns * window->rows, &result),
        "cannot allocate tile window");
  visitTileWindow(env, args[0], *window, [&](std::uint32_t index, napi_value cell) {
    check(env, napi_set_element(env, result, index, cell), "cannot retain tile cell");
  });
  return result;
} catch (const std::exception& error) { return throwException(env, error); }

napi_value sameTileWindow(napi_env env, napi_callback_info info) try {
  const auto args = arguments(env, info);
  if (args.size() != 11) throw std::invalid_argument("tile window comparison requires arrays and geometry");
  const auto window = tileWindow(env, args, 2, 9);
  if (!window) return null(env);
  bool array = false;
  check(env, napi_is_array(env, args[1], &array), "cannot inspect tile snapshot");
  if (!array) return null(env);
  napi_valuetype type;
  check(env, napi_typeof(env, args[8], &type), "cannot inspect tile snapshot offset");
  if (type != napi_number) return null(env);
  const double offset = asNumber(env, args[8]);
  std::uint32_t length = 0;
  check(env, napi_get_array_length(env, args[1], &length), "cannot read tile snapshot length");
  if (!std::isfinite(offset) || std::floor(offset) != offset || offset < 0 ||
      offset + std::uint64_t(window->columns) * window->rows > length) return null(env);
  bool equal = true;
  visitTileWindow(env, args[0], *window, [&](std::uint32_t index, napi_value cell) {
    napi_value expected;
    check(env, napi_get_element(env, args[1], static_cast<std::uint32_t>(offset) + index, &expected),
          "cannot read retained tile cell");
    bool same = false;
    check(env, napi_strict_equals(env, cell, expected, &same), "cannot compare tile cells");
    equal = equal && same;
  });
  return boolean(env, equal);
} catch (const std::exception& error) { return throwException(env, error); }

} // namespace

void registerYedBindings(napi_env env, napi_value plugins) {
  napi_value yed = moduleObject(env);
  method(env, yed, "readTileWindow", readTileWindow);
  method(env, yed, "sameTileWindow", sameTileWindow);
  check(env, napi_set_named_property(env, plugins, "yed", yed), "cannot register YED bindings");
}

} // namespace pmjs::addon
