#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <queue>
#include <sstream>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace {

using Clock = std::chrono::steady_clock;

struct Card {
  uint8_t rank;
  uint8_t suit;
  uint8_t copy;
  bool face_up;
};

struct Move {
  bool draw = false;
  uint8_t from = 0;
  uint8_t index = 0;
  uint8_t to = 0;
};

struct Board {
  std::vector<Card> columns[10];
  Card stock[5][10];
  uint8_t stock_index = 0;
  uint8_t completed = 0;
};

struct SearchNode {
  Board board;
  std::vector<Move> path;
  int64_t score = 0;
  uint64_t serial = 0;
};

struct HigherScore {
  bool operator()(const SearchNode& left, const SearchNode& right) const {
    if (left.score != right.score) return left.score < right.score;
    return left.serial > right.serial;
  }
};

struct Options {
  int suit_count = 4;
  uint64_t seed = 1;
  uint64_t timeout_ms = 30'000;
  uint64_t max_states = 1'000'000;
  uint64_t max_frontier = 120'000;
};

struct Result {
  bool solved = false;
  bool timed_out = false;
  bool state_limit = false;
  uint64_t states = 0;
  uint64_t unique_states = 0;
  uint64_t elapsed_ms = 0;
  Board initial;
  std::vector<Move> solution;
};

class Random {
 public:
  explicit Random(uint64_t seed) : state_(seed ? seed : 0x9e3779b97f4a7c15ULL) {}

  uint64_t next() {
    uint64_t value = (state_ += 0x9e3779b97f4a7c15ULL);
    value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ULL;
    value = (value ^ (value >> 27)) * 0x94d049bb133111ebULL;
    return value ^ (value >> 31);
  }

  size_t index(size_t bound) { return bound == 0 ? 0 : static_cast<size_t>(next() % bound); }

 private:
  uint64_t state_;
};

std::string suit_name(uint8_t suit) {
  static const char* names[] = {"spades", "hearts", "diamonds", "clubs"};
  return names[suit % 4];
}

uint64_t parse_u64(const char* value, const char* flag) {
  char* end = nullptr;
  const auto parsed = std::strtoull(value, &end, 10);
  if (!end || *end != '\0') {
    std::cerr << "Invalid value for " << flag << "\n";
    std::exit(2);
  }
  return parsed;
}

Options parse_options(int argc, char** argv) {
  Options options;
  for (int i = 1; i < argc; ++i) {
    const std::string flag = argv[i];
    if (flag == "--help") {
      std::cout << "Usage: spider-solver --mode 1|2|3|4 --seed N [--timeout-ms N] [--max-states N] [--max-frontier N]\n";
      std::exit(0);
    }
    if (i + 1 >= argc) {
      std::cerr << "Missing value for " << flag << "\n";
      std::exit(2);
    }
    const auto value = parse_u64(argv[++i], flag.c_str());
    if (flag == "--mode") options.suit_count = static_cast<int>(value);
    else if (flag == "--seed") options.seed = value;
    else if (flag == "--timeout-ms") options.timeout_ms = value;
    else if (flag == "--max-states") options.max_states = value;
    else if (flag == "--max-frontier") options.max_frontier = value;
    else {
      std::cerr << "Unknown option: " << flag << "\n";
      std::exit(2);
    }
  }
  if (options.suit_count < 1 || options.suit_count > 4) {
    std::cerr << "Mode must be 1, 2, 3, or 4\n";
    std::exit(2);
  }
  return options;
}

Board random_deal(const Options& options) {
  Random random(options.seed);
  std::vector<Card> deck;
  deck.reserve(104);
  for (uint8_t run = 0; run < 8; ++run) {
    const uint8_t suit = static_cast<uint8_t>(run % options.suit_count);
    for (uint8_t rank = 1; rank <= 13; ++rank) deck.push_back({rank, suit, run, false});
  }
  for (size_t i = deck.size() - 1; i > 0; --i) std::swap(deck[i], deck[random.index(i + 1)]);

  Board board;
  size_t cursor = 0;
  for (int row = 0; row < 6; ++row) {
    for (int column = 0; column < 10; ++column) {
      if (row == 5 && column >= 4) continue;
      board.columns[column].push_back(deck[cursor++]);
    }
  }
  for (auto& column : board.columns) column.back().face_up = true;
  for (int deal = 0; deal < 5; ++deal) {
    for (int column = 0; column < 10; ++column) board.stock[deal][column] = deck[cursor++];
  }
  return board;
}

bool same_run_step(const Card& lower, const Card& upper) {
  return lower.face_up && upper.face_up && lower.suit == upper.suit && lower.rank == upper.rank + 1;
}

void remove_completed(Board& board) {
  bool changed = true;
  while (changed) {
    changed = false;
    for (auto& column : board.columns) {
      if (column.size() < 13) continue;
      const size_t start = column.size() - 13;
      const uint8_t suit = column[start].suit;
      bool complete = true;
      for (size_t offset = 0; offset < 13; ++offset) {
        const auto& card = column[start + offset];
        if (!card.face_up || card.suit != suit || card.rank != 13 - offset) {
          complete = false;
          break;
        }
      }
      if (!complete) continue;
      column.resize(start);
      if (!column.empty()) column.back().face_up = true;
      ++board.completed;
      changed = true;
    }
  }
}

std::vector<Move> legal_moves(const Board& board) {
  std::vector<Move> moves;
  moves.reserve(96);
  for (uint8_t from = 0; from < 10; ++from) {
    const auto& source = board.columns[from];
    if (source.empty() || !source.back().face_up) continue;
    size_t first = source.size() - 1;
    while (first > 0 && same_run_step(source[first - 1], source[first])) --first;
    for (size_t start = first; start < source.size(); ++start) {
      const auto& moving = source[start];
      bool used_empty = false;
      for (uint8_t to = 0; to < 10; ++to) {
        if (to == from) continue;
        const auto& target = board.columns[to];
        if (target.empty()) {
          if (used_empty || start == 0) continue;
          used_empty = true;
          moves.push_back({false, from, static_cast<uint8_t>(start), to});
        } else if (target.back().face_up && target.back().rank == moving.rank + 1) {
          moves.push_back({false, from, static_cast<uint8_t>(start), to});
        }
      }
    }
  }
  if (board.stock_index < 5) moves.push_back({true, 0, 0, 0});
  return moves;
}

Board apply_move(const Board& board, const Move& move) {
  Board next = board;
  if (move.draw) {
    for (int column = 0; column < 10; ++column) {
      Card card = next.stock[next.stock_index][column];
      card.face_up = true;
      next.columns[column].push_back(card);
    }
    ++next.stock_index;
  } else {
    auto& source = next.columns[move.from];
    auto& target = next.columns[move.to];
    target.insert(target.end(), source.begin() + move.index, source.end());
    source.resize(move.index);
    if (!source.empty()) source.back().face_up = true;
  }
  remove_completed(next);
  return next;
}

int64_t board_score(const Board& board, const Move* last_move = nullptr) {
  int hidden = 0;
  int face_up = 0;
  int suited_links = 0;
  int rank_links = 0;
  int suit_breaks = 0;
  int empty = 0;
  int exposed_kings = 0;
  for (const auto& column : board.columns) {
    if (column.empty()) {
      ++empty;
      continue;
    }
    if (column.back().rank == 13) ++exposed_kings;
    for (size_t i = 0; i < column.size(); ++i) {
      if (column[i].face_up) ++face_up;
      else ++hidden;
      if (i == 0 || !column[i - 1].face_up || !column[i].face_up) continue;
      if (column[i - 1].rank == column[i].rank + 1) {
        ++rank_links;
        if (column[i - 1].suit == column[i].suit) ++suited_links;
        else ++suit_breaks;
      }
    }
  }
  int64_t score = static_cast<int64_t>(board.completed) * 12'000'000
      - static_cast<int64_t>(hidden) * 55'000
      - static_cast<int64_t>(5 - board.stock_index) * 9'000
      + static_cast<int64_t>(suited_links) * 4'800
      + static_cast<int64_t>(rank_links) * 500
      - static_cast<int64_t>(suit_breaks) * 750
      + static_cast<int64_t>(face_up) * 110
      + static_cast<int64_t>(empty) * (board.stock_index == 5 ? 5'500 : 1'100)
      - static_cast<int64_t>(exposed_kings) * 120;
  if (last_move && !last_move->draw) {
    const auto& target = board.columns[last_move->to];
    if (target.size() >= 2 && target[target.size() - 1].suit == target[target.size() - 2].suit) score += 2'500;
  }
  return score;
}

std::string state_key(const Board& board) {
  std::string key;
  key.reserve(230);
  key.push_back(static_cast<char>(board.stock_index));
  key.push_back(static_cast<char>(board.completed));
  for (const auto& column : board.columns) {
    key.push_back(static_cast<char>(column.size()));
    for (const auto& card : column) {
      key.push_back(static_cast<char>(card.rank | (card.suit << 4) | (card.face_up ? 0x40 : 0)));
    }
    key.push_back(static_cast<char>(0xff));
  }
  return key;
}

bool is_won(const Board& board) {
  if (board.completed != 8 || board.stock_index != 5) return false;
  for (const auto& column : board.columns) if (!column.empty()) return false;
  return true;
}

Result best_first_solve(const Options& options) {
  Result result;
  result.initial = random_deal(options);
  auto started = Clock::now();
  const auto deadline = started + std::chrono::milliseconds(options.timeout_ms);
  std::priority_queue<SearchNode, std::vector<SearchNode>, HigherScore> frontier;
  std::unordered_set<std::string> visited;
  visited.reserve(static_cast<size_t>(std::min<uint64_t>(options.max_states, 2'000'000)));
  uint64_t serial = 0;
  frontier.push({result.initial, {}, board_score(result.initial), serial++});

  while (!frontier.empty()) {
    if (result.states >= options.max_states) {
      result.state_limit = true;
      break;
    }
    if ((result.states & 1023ULL) == 0 && Clock::now() >= deadline) {
      result.timed_out = true;
      break;
    }
    // priority_queue::top() is const because changing the key before pop() can
    // invalidate the heap. Copy here; the node is immediately removed.
    SearchNode node = frontier.top();
    frontier.pop();
    const auto key = state_key(node.board);
    if (!visited.insert(key).second) continue;
    ++result.states;
    if (is_won(node.board)) {
      result.solved = true;
      result.solution = std::move(node.path);
      break;
    }

    auto moves = legal_moves(node.board);
    std::vector<SearchNode> children;
    children.reserve(moves.size());
    for (const auto& move : moves) {
      Board child_board = apply_move(node.board, move);
      auto child_path = node.path;
      child_path.push_back(move);
      int64_t score = board_score(child_board, &move) - static_cast<int64_t>(child_path.size()) * 8;
      children.push_back({std::move(child_board), std::move(child_path), score, serial++});
    }
    std::sort(children.begin(), children.end(), [](const SearchNode& a, const SearchNode& b) {
      return a.score > b.score;
    });
    for (auto& child : children) frontier.push(std::move(child));

    if (frontier.size() > options.max_frontier) {
      std::vector<SearchNode> kept;
      kept.reserve(options.max_frontier * 3 / 4);
      while (!frontier.empty() && kept.size() < options.max_frontier * 3 / 4) {
        kept.push_back(frontier.top());
        frontier.pop();
      }
      frontier = {};
      for (auto& item : kept) frontier.push(std::move(item));
    }
  }

  result.unique_states = visited.size();
  result.elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - started).count();
  return result;
}

struct ChunkOutcome {
  bool solved = false;
  bool improved = false;
  Board board;
  std::vector<Move> path;
  int64_t score = std::numeric_limits<int64_t>::min();
};

class CheckpointSolver {
 public:
  explicit CheckpointSolver(const Options& options)
      : options_(options), started_(Clock::now()), deadline_(started_ + std::chrono::milliseconds(options.timeout_ms)) {}

  Result run() {
    Result result;
    result.initial = random_deal(options_);
    const int attempts = options_.suit_count == 2 ? 20 : 28;
    std::vector<Move> best_partial;
    int64_t best_partial_score = board_score(result.initial);

    for (int attempt = 0; attempt < attempts && !stopped(); ++attempt) {
      Board current = result.initial;
      std::vector<Move> unified;
      std::unordered_set<std::string> adopted;
      adopted.insert(state_key(current));
      std::unordered_map<std::string, uint8_t> transpositions;
      int checkpoints_since_draw = 0;
      int stalls = 0;
      const int max_checkpoints = options_.suit_count >= 3 ? 100 : 70;

      for (int checkpoint = 0; checkpoint < max_checkpoints && !stopped(); ++checkpoint) {
        const bool deal_eager = attempt >= 6 && checkpoints_since_draw >= (options_.suit_count >= 3 ? 2 : 3);
        if (deal_eager && current.stock_index < 5) {
          Move draw{true, 0, 0, 0};
          Board dealt = apply_move(current, draw);
          const auto key = state_key(dealt);
          if (adopted.insert(key).second) {
            current = std::move(dealt);
            unified.push_back(draw);
            checkpoints_since_draw = 0;
            continue;
          }
        }

        const int64_t start_score = board_score(current);
        auto outcome = search_chunk(current, attempt, transpositions);
        if (outcome.solved) {
          unified.insert(unified.end(), outcome.path.begin(), outcome.path.end());
          result.solved = true;
          result.solution = std::move(unified);
          finish(result);
          return result;
        }

        bool adopted_progress = false;
        if (outcome.improved && outcome.score >= start_score + adoption_threshold()) {
          const auto key = state_key(outcome.board);
          if (adopted.insert(key).second) {
            current = std::move(outcome.board);
            unified.insert(unified.end(), outcome.path.begin(), outcome.path.end());
            ++checkpoints_since_draw;
            stalls = 0;
            adopted_progress = true;
            if (outcome.score > best_partial_score) {
              best_partial_score = outcome.score;
              best_partial = unified;
            }
          }
        }
        if (adopted_progress) continue;

        ++stalls;
        if (current.stock_index < 5) {
          Move draw{true, 0, 0, 0};
          Board dealt = apply_move(current, draw);
          const auto key = state_key(dealt);
          if (adopted.insert(key).second) {
            current = std::move(dealt);
            unified.push_back(draw);
            checkpoints_since_draw = 0;
            stalls = 0;
            continue;
          }
        }
        if (stalls >= 2) break;
      }
    }

    result.timed_out = Clock::now() >= deadline_;
    result.state_limit = states_ >= options_.max_states;
    finish(result);
    return result;
  }

 private:
  struct DfsContext {
    uint64_t nodes = 0;
    uint64_t budget = 0;
    int64_t initial_score = 0;
    ChunkOutcome outcome;
  };

  const Options& options_;
  Clock::time_point started_;
  Clock::time_point deadline_;
  uint64_t states_ = 0;
  uint64_t unique_ = 0;

  bool stopped() const { return states_ >= options_.max_states || Clock::now() >= deadline_; }

  int64_t adoption_threshold() const {
    if (options_.suit_count == 2) return 1'500;
    if (options_.suit_count == 3) return 1'000;
    return 700;
  }

  uint64_t chunk_budget(int attempt) const {
    uint64_t base = options_.suit_count == 2 ? 90'000 : 130'000;
    if (attempt < 3) return base * 2 / 5;
    if (attempt >= 10) return base * 3 / 2;
    return base;
  }

  void finish(Result& result) {
    result.states = states_;
    result.unique_states = unique_;
    result.elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - started_).count();
  }

  ChunkOutcome search_chunk(
      const Board& board,
      int attempt,
      std::unordered_map<std::string, uint8_t>& transpositions) {
    DfsContext context;
    context.budget = chunk_budget(attempt);
    context.initial_score = board_score(board);
    context.outcome.board = board;
    context.outcome.score = context.initial_score;
    std::vector<Move> path;
    std::unordered_set<std::string> path_states;
    path_states.insert(state_key(board));
    dfs(board, 0, 15, attempt, path, path_states, transpositions, context);
    return std::move(context.outcome);
  }

  static int suited_links(const Board& board) {
    int total = 0;
    for (const auto& column : board.columns) {
      for (size_t i = 1; i < column.size(); ++i) if (same_run_step(column[i - 1], column[i])) ++total;
    }
    return total;
  }

  int64_t ordering_score(const Board& from, const Board& to, const Move& move, int attempt) const {
    int bucket = 5;
    if (to.completed > from.completed) bucket = 0;
    else {
      int before_hidden = 0;
      int after_hidden = 0;
      for (int column = 0; column < 10; ++column) {
        for (const auto& card : from.columns[column]) if (!card.face_up) ++before_hidden;
        for (const auto& card : to.columns[column]) if (!card.face_up) ++after_hidden;
      }
      if (after_hidden < before_hidden) bucket = 1;
      else if (suited_links(to) > suited_links(from)) bucket = 2;
      else if (move.draw) bucket = 6;
      else if (!from.columns[move.to].empty() &&
               from.columns[move.to].back().suit == from.columns[move.from][move.index].suit) bucket = 3;
    }
    uint64_t noise = 0;
    if (attempt > 0) {
      noise = (static_cast<uint64_t>(attempt) * 6364136223846793005ULL
          + move.from * 97ULL + move.to * 193ULL + move.index * 389ULL) % (200ULL * (1 + attempt / 8));
    }
    return -static_cast<int64_t>(bucket) * 10'000'000 + (board_score(to, &move) - board_score(from)) + noise;
  }

  void dfs(
      const Board& board,
      int depth,
      int max_depth,
      int attempt,
      std::vector<Move>& path,
      std::unordered_set<std::string>& path_states,
      std::unordered_map<std::string, uint8_t>& transpositions,
      DfsContext& context) {
    if (context.outcome.solved || context.nodes >= context.budget || stopped() || depth >= max_depth) return;
    ++context.nodes;
    ++states_;
    if ((states_ & 1023ULL) == 0 && Clock::now() >= deadline_) return;
    if (is_won(board)) {
      context.outcome.solved = true;
      context.outcome.path = path;
      context.outcome.board = board;
      return;
    }

    const int64_t score = board_score(board);
    if (score > context.outcome.score) {
      context.outcome.improved = score > context.initial_score;
      context.outcome.score = score;
      context.outcome.board = board;
      context.outcome.path = path;
    }

    const auto key = state_key(board);
    auto [entry, inserted] = transpositions.emplace(key, static_cast<uint8_t>(depth));
    if (!inserted) {
      if (entry->second <= depth) return;
      entry->second = static_cast<uint8_t>(depth);
    } else {
      ++unique_;
    }
    if (transpositions.size() > options_.max_frontier * 8) transpositions.clear();

    struct Transition { Move move; Board board; int64_t order; };
    std::vector<Transition> transitions;
    for (const auto& move : legal_moves(board)) {
      if (!path.empty() && !move.draw && !path.back().draw &&
          move.from == path.back().to && move.to == path.back().from) continue;
      Board child = apply_move(board, move);
      transitions.push_back({move, std::move(child), 0});
      transitions.back().order = ordering_score(board, transitions.back().board, move, attempt);
    }
    std::sort(transitions.begin(), transitions.end(), [](const Transition& a, const Transition& b) {
      return a.order > b.order;
    });

    for (auto& transition : transitions) {
      if (context.outcome.solved || context.nodes >= context.budget || stopped()) return;
      const auto child_key = state_key(transition.board);
      if (!path_states.insert(child_key).second) continue;
      path.push_back(transition.move);
      dfs(transition.board, depth + 1, max_depth, attempt, path, path_states, transpositions, context);
      path.pop_back();
      path_states.erase(child_key);
    }
  }
};

Result solve(const Options& options) {
  if (options.suit_count == 1) return best_first_solve(options);
  return CheckpointSolver(options).run();
}

void print_card_json(const Card& card) {
  std::cout << "{\"id\":\"" << suit_name(card.suit) << "-copy-" << static_cast<int>(card.copy)
            << "-rank-" << static_cast<int>(card.rank) << "\",\"rank\":" << static_cast<int>(card.rank)
            << ",\"suit\":\"" << suit_name(card.suit) << "\",\"faceUp\":"
            << (card.face_up ? "true" : "false") << "}";
}

void print_result(const Options& options, const Result& result) {
  const char* status = result.solved ? "solved" : result.timed_out ? "timeout" : result.state_limit ? "state-limit" : "exhausted";
  std::cout << "{\"status\":\"" << status << "\",\"mode\":\"" << options.suit_count
            << "-suit\",\"seed\":\"" << options.seed << "\",\"elapsedMs\":" << result.elapsed_ms
            << ",\"statesSearched\":" << result.states << ",\"uniqueStates\":" << result.unique_states;
  if (result.solved) {
    std::cout << ",\"deal\":{\"columns\":[";
    for (int column = 0; column < 10; ++column) {
      if (column) std::cout << ',';
      std::cout << '[';
      for (size_t i = 0; i < result.initial.columns[column].size(); ++i) {
        if (i) std::cout << ',';
        print_card_json(result.initial.columns[column][i]);
      }
      std::cout << ']';
    }
    std::cout << "],\"stock\":[";
    for (int deal = 0; deal < 5; ++deal) {
      if (deal) std::cout << ',';
      std::cout << '[';
      for (int column = 0; column < 10; ++column) {
        if (column) std::cout << ',';
        print_card_json(result.initial.stock[deal][column]);
      }
      std::cout << ']';
    }
    std::cout << "],\"solution\":[";
    for (size_t i = 0; i < result.solution.size(); ++i) {
      if (i) std::cout << ',';
      const auto& move = result.solution[i];
      if (move.draw) std::cout << "{\"type\":\"draw\"}";
      else std::cout << "{\"type\":\"move\",\"fromColumn\":" << static_cast<int>(move.from)
                     << ",\"cardIndex\":" << static_cast<int>(move.index)
                     << ",\"toColumn\":" << static_cast<int>(move.to) << "}";
    }
    std::cout << "]}";
  }
  std::cout << "}\n";
}

}  // namespace

int main(int argc, char** argv) {
  const Options options = parse_options(argc, argv);
  print_result(options, solve(options));
  return 0;
}
