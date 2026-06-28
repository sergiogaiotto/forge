import sys
import random
from dataclasses import dataclass
from typing import List, Tuple

import pygame
from pygame.locals import (
    QUIT,
    KEYDOWN,
    K_ESCAPE,
    K_UP,
    K_DOWN,
    K_LEFT,
    K_RIGHT,
)

# ----------------------------------------------------------------------
# Configurações do jogo
# ----------------------------------------------------------------------
WINDOW_WIDTH: int = 600
WINDOW_HEIGHT: int = 400
CELL_SIZE: int = 20                     # tamanho de cada quadrado da grade
FPS: int = 10                           # velocidade inicial da cobra

# Cores (R, G, B)
BLACK: Tuple[int, int, int] = (0, 0, 0)
WHITE: Tuple[int, int, int] = (255, 255, 255)
GREEN: Tuple[int, int, int] = (0, 255, 0)
RED: Tuple[int, int, int] = (255, 0, 0)

# Direções (dx, dy)
UP: Tuple[int, int] = (0, -1)
DOWN: Tuple[int, int] = (0, 1)
LEFT: Tuple[int, int] = (-1, 0)
RIGHT: Tuple[int, int] = (1, 0)


@dataclass
class Food:
    """Representa a comida que a cobra deve comer."""
    position: Tuple[int, int]

    @staticmethod
    def random_position(exclude: List[Tuple[int, int]]) -> Tuple[int, int]:
        """Gera uma posição aleatória que não esteja na lista `exclude`."""
        max_x = WINDOW_WIDTH // CELL_SIZE
        max_y = WINDOW_HEIGHT // CELL_SIZE
        while True:
            pos = (random.randint(0, max_x - 1), random.randint(0, max_y - 1))
            if pos not in exclude:
                return pos


class Snake:
    """Representa a cobrinha."""

    def __init__(self) -> None:
        # Começa no centro da tela, com 3 segmentos
        init_x = WINDOW_WIDTH // (2 * CELL_SIZE)
        init_y = WINDOW_HEIGHT // (2 * CELL_SIZE)
        self.body: List[Tuple[int, int]] = [
            (init_x, init_y),
            (init_x - 1, init_y),
            (init_x - 2, init_y),
        ]
        self.direction: Tuple[int, int] = RIGHT
        self.grow_pending: int = 0

    def head(self) -> Tuple[int, int]:
        return self.body[0]

    def move(self) -> None:
        """Move a cobra uma célula na direção atual."""
        dx, dy = self.direction
        new_head = (self.head()[0] + dx, self.head()[1] + dy)
        self.body.insert(0, new_head)

        # Se não houver crescimento pendente, remove a cauda
        if self.grow_pending > 0:
            self.grow_pending -= 1
        else:
            self.body.pop()

    def grow(self, amount: int = 1) -> None:
        """Define quantos segmentos a mais a cobra deve ganhar."""
        self.grow_pending += amount

    def change_direction(self, new_dir: Tuple[int, int]) -> None:
        """Altera a direção, impedindo 180° imediatos."""
        opposite = (-self.direction[0], -self.direction[1])
        if new_dir != opposite:
            self.direction = new_dir

    def collides_with_self(self) -> bool:
        """Retorna True se a cabeça colidir com o corpo."""
        return self.head() in self.body[1:]

    def collides_with_wall(self) -> bool:
        """Retorna True se a cabeça estiver fora dos limites da tela."""
        x, y = self.head()
        max_x = WINDOW_WIDTH // CELL_SIZE
        max_y = WINDOW_HEIGHT // CELL_SIZE
        return not (0 <= x < max_x and 0 <= y < max_y)


def draw_cell(surface: pygame.Surface, color: Tuple[int, int, int],
              position: Tuple[int, int]) -> None:
    """Desenha um quadrado na coordenada da grade."""
    rect = pygame.Rect(
        position[0] * CELL_SIZE,
        position[1] * CELL_SIZE,
        CELL_SIZE,
        CELL_SIZE,
    )
    pygame.draw.rect(surface, color, rect)


def render(screen: pygame.Surface, snake: Snake, food: Food) -> None:
    """Desenha todo o estado atual do jogo."""
    screen.fill(BLACK)

    # Desenha a comida
    draw_cell(screen, RED, food.position)

    # Desenha a cobra
    for i, segment in enumerate(snake.body):
        color = GREEN if i == 0 else WHITE  # cabeça em verde
        draw_cell(screen, color, segment)

    pygame.display.flip()


def handle_events(snake: Snake) -> bool:
    """Processa eventos do pygame. Retorna False se o usuário fechar a janela."""
    for event in pygame.event.get():
        if event.type == QUIT:
            return False
        elif event.type == KEYDOWN:
            if event.key == K_ESCAPE:
                return False
            elif event.key == K_UP:
                snake.change_direction(UP)
            elif event.key == K_DOWN:
                snake.change_direction(DOWN)
            elif event.key == K_LEFT:
                snake.change_direction(LEFT)
            elif event.key == K_RIGHT:
                snake.change_direction(RIGHT)
    return True


def main() -> None:
    """Loop principal do jogo."""
    # Inicialização defensiva do pygame
    try:
        pygame.init()
    except Exception as exc:
        print(f"Erro ao iniciar pygame: {exc}", file=sys.stderr)
        sys.exit(1)

    screen = pygame.display.set_mode((WINDOW_WIDTH, WINDOW_HEIGHT))
    pygame.display.set_caption("Jogo da Cobrinha")
    clock = pygame.time.Clock()

    snake = Snake()
    food = Food(Food.random_position(snake.body))

    running = True
    while running:
        running = handle_events(snake)

        snake.move()

        # Verifica colisões
        if snake.collides_with_wall() or snake.collides_with_self():
            print("Game Over! Pontuação:", len(snake.body) - 3)
            running = False
            continue

        # Comer a comida
        if snake.head() == food.position:
            snake.grow()
            # Gera nova comida que não esteja sobre a cobra
            food.position = Food.random_position(snake.body)

        render(screen, snake, food)

        # Controle de velocidade (pode ser ajustado dinamicamente)
        clock.tick(FPS)

    pygame.quit()


if __name__ == "__main__":