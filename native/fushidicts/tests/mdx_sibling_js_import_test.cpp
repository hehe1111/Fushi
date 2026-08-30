// BUG-1651: MDX dictionaries (OALD/OALDPEX and friends) ship interactive
// behavior as a sibling JS (Foo.mdx -> Foo.js) the host is expected to load.
// import_mdx must persist that sibling as the dict's script.js so the query side
// can hand it to the popup for controlled execution.
//
// This test drives BOTH entry paths:
//   1. zip import (Foo.mdx + Foo.js inside the zip) -> script.js written with
//      matching bytes (import_mdx_from_zip must not drop the .js anymore);
//   2. DictionaryQuery::get_scripts() -> {dict_name, script} round-trips the
//      bytes loaded from script.js.
//
// Red/green: revert the importer's .js extraction/read_sibling_js wiring and
// script.js is absent (zip path) -> FAIL.
//
// Usage: mdx_sibling_js_import_test  (no args) -> exit 0 PASS, non-zero FAIL.
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "fushidicts/importer.hpp"
#include "fushidicts/query.hpp"
#include "mdx_fixture.hpp"
#include "zip_fixture.hpp"

namespace {
int g_fail = 0;
void fail(const char* msg) {
  std::fprintf(stderr, "FAIL: %s\n", msg);
  ++g_fail;
}
}  // namespace

int main() {
  const std::string js = "window.oaldStyle=1;function toggleNoun(){return true;}";
  const std::string base = fushi_test::temp_dir() + "/hoshi_mdx_js";

  // 1. zip import path: Foo.mdx + Foo.js, both under the same stem.
  {
    auto mdx_bytes = mdx_fixture::build_mdx_plain(
        "JsDict", {{"hassling", "<script src=\"JsDict.js\"></script>def"}});
    std::vector<fushi_test::ZipFile> files = {
        {"JsDict.mdx", std::string(mdx_bytes.begin(), mdx_bytes.end())},
        {"JsDict.js", js},
    };
    std::string zip_path = fushi_test::write_zip("mdx_js", files);
    if (zip_path.empty()) {
      fail("could not write fixture zip");
    } else {
      const std::string out_dir = base + "/zip_out";
      ImportResult r = dictionary_importer::import(zip_path, out_dir);
      if (!r.success) {
        fail(r.errors.empty() ? "zip import failed" : r.errors.front().c_str());
      } else {
        const std::string script_path = out_dir + "/" + r.title + "/script.js";
        std::ifstream sf(std::filesystem::u8path(script_path), std::ios::binary);
        if (!sf) {
          fail("script.js was not written from zip sibling .js");
        } else {
          std::string got((std::istreambuf_iterator<char>(sf)),
                          std::istreambuf_iterator<char>());
          if (got != js) {
            std::fprintf(stderr, "FAIL zip script.js: got %zu bytes want %zu\n",
                         got.size(), js.size());
            ++g_fail;
          }
        }
        // 2. query side: get_scripts round-trips the persisted bytes.
        if (r.success) {
          DictionaryQuery q;
          q.add_term_dict(out_dir + "/" + r.title);
          auto scripts = q.get_scripts();
          if (scripts.size() != 1 || scripts[0].dict_name != r.title ||
              scripts[0].script != js) {
            std::fprintf(stderr, "FAIL get_scripts: got %zu entries\n",
                         scripts.size());
            ++g_fail;
          }
        }
      }
    }
  }

  // 3. loose-directory import path (single .mdx with a sibling .js on disk):
  //    read_sibling_js must pick it up too, not just the zip extraction.
  {
    const std::string dir = base + "/loose";
    std::filesystem::create_directories(std::filesystem::u8path(dir));
    const std::string mdx_path = dir + "/LooseDict.mdx";
    const std::string js_path = dir + "/LooseDict.js";
    auto mdx_bytes = mdx_fixture::build_mdx_plain(
        "LooseDict", {{"apple", "<script src=\"LooseDict.js\"></script>def"}});
    {
      std::ofstream f(std::filesystem::u8path(mdx_path), std::ios::binary);
      f.write(reinterpret_cast<const char*>(mdx_bytes.data()),
              static_cast<std::streamsize>(mdx_bytes.size()));
    }
    {
      std::ofstream f(std::filesystem::u8path(js_path), std::ios::binary);
      f.write(js.data(), static_cast<std::streamsize>(js.size()));
    }
    const std::string out_dir = base + "/loose_out";
    ImportResult r = dictionary_importer::import(mdx_path, out_dir);
    if (!r.success) {
      fail(r.errors.empty() ? "loose import failed" : r.errors.front().c_str());
    } else {
      const std::string script_path = out_dir + "/" + r.title + "/script.js";
      std::ifstream sf(std::filesystem::u8path(script_path), std::ios::binary);
      if (!sf) {
        fail("loose import: script.js was not written from sibling .js");
      } else {
        std::string got((std::istreambuf_iterator<char>(sf)),
                        std::istreambuf_iterator<char>());
        if (got != js) {
          std::fprintf(stderr, "FAIL loose script.js: got %zu bytes want %zu\n",
                       got.size(), js.size());
          ++g_fail;
        }
      }
    }
  }

  if (g_fail) {
    std::fprintf(stderr, "%d FAIL\n", g_fail);
    return 1;
  }
  std::printf("PASS\n");
  return 0;
}
